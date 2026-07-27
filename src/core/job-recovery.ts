import { listJobs, readJob } from "./job-store.js";
import {
  transitionJob,
  type JobTransitionResult
} from "./job-transition.js";
import {
  spawnNotificationWorker,
  verifyProcessIdentity,
  type ProcessIdentityVerification
} from "./job-process.js";
import { startNotificationDispatch } from "../notify/dispatch-process.js";
import {
  advanceJobChainAfterChild,
  continueJobChainOrchestration,
  type AdvanceJobChainAfterChildDependencies
} from "./job-definitions.js";
import {
  isUnfinishedJobChain,
  listJobChains,
  type JobChainRecord
} from "./job-chain.js";
import type { JobRecord, JobStatus } from "./jobs.js";
import { isProcessLockHeld } from "./process-lock.js";
import { resolveJobWorkerOwnershipKey } from "./worker-ownership.js";

const DEFAULT_STALE_THRESHOLD_MS = 300_000;

const TERMINAL_STATUSES = new Set<JobStatus>([
  "needs_input",
  "blocked",
  "stalled",
  "completed",
  "failed",
  "cancelled",
  "timeout"
]);

export interface StaleJobRecoveryOptions {
  staleThresholdMs?: number;
  now?: () => number;
  spawnNotificationWorker?: typeof spawnNotificationWorker;
  transitionJob?: typeof transitionJob;
}

export interface ChainCrashRecoveryOptions extends AdvanceJobChainAfterChildDependencies {
  listJobChains?: typeof listJobChains;
  readJob?: typeof readJob;
  transitionJob?: typeof transitionJob;
  advanceJobChainAfterChild?: typeof advanceJobChainAfterChild;
  workerOwnershipIsHeld?: typeof isProcessLockHeld;
  processIsRunning?: (pid: number) => boolean;
  verifyProcess?: (
    pid: number,
    expectedIdentity: string | null | undefined
  ) => ProcessIdentityVerification;
  spawnNotificationWorker?: typeof spawnNotificationWorker;
}

export interface ChainCrashRecoveryResult {
  recoveredChildIds: string[];
}

export async function recoverStaleQueuedJobs(
  cwd: string,
  options: StaleJobRecoveryOptions = {}
): Promise<JobTransitionResult[]> {
  const threshold = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const cutoff = (options.now ?? Date.now)() - threshold;
  const recovered: JobTransitionResult[] = [];
  const transition = options.transitionJob ?? transitionJob;

  for (const job of listJobs(cwd)) {
    if (job.status !== "queued" || Date.parse(job.createdAt) >= cutoff) continue;
    const summary = `Job stuck in queued state for longer than ${Math.round(threshold / 1000)}s. Worker process may have failed to start.`;
    let result: JobTransitionResult;
    try {
      result = await transition(cwd, job.id, {
        status: "failed",
        summary,
        error: summary,
        errorCode: "stale_queued"
      });
    } catch (error) {
      const raced = readJob(cwd, job.id);
      if (raced?.status === "failed" && raced.errorCode === "stale_queued") continue;
      if (!raced || raced.status !== "queued") continue;
      throw error;
    }
    recovered.push(result);
    if (result.deliveryCreated) {
      startNotificationDispatch(cwd, {
        spawnNotificationWorker: options.spawnNotificationWorker
      });
    }
  }
  return recovered;
}

/**
 * Crash recovery for durable slice chains:
 * - unfinished chains remain durable work (caller keeps supervisor alive)
 * - completed slices are never relaunched
 * - live owned/running slices are left alone
 * - running slices without a live process become stalled (worker_lost) and advance root attention
 * - completed current + ready pending (or all-completed) with no live child re-enters advance/finalize
 */
export async function recoverUnfinishedJobChains(
  cwd: string,
  options: ChainCrashRecoveryOptions = {}
): Promise<ChainCrashRecoveryResult> {
  const loadChains = options.listJobChains ?? listJobChains;
  const loadJob = options.readJob ?? readJob;
  const ownershipIsHeld = options.workerOwnershipIsHeld ?? isProcessLockHeld;
  const isRunning = options.processIsRunning ?? defaultProcessIsRunning;
  const verify = options.verifyProcess ?? verifyProcessIdentity;
  const transition = options.transitionJob ?? transitionJob;
  const advance = options.advanceJobChainAfterChild ?? advanceJobChainAfterChild;
  const continueChain = continueJobChainOrchestration;
  const recoveredChildIds: string[] = [];

  for (const chain of loadChains(cwd)) {
    const unfinished = isUnfinishedJobChain(chain);
    const root = loadJob(cwd, chain.rootJobId);
    const orchestratorNeedsContinue =
      Boolean(root && root.status === "running") &&
      !Object.values(chain.sliceStates).some((state) => state === "running");
    if (!unfinished && !orchestratorNeedsContinue) continue;

    for (const sliceId of runningSliceIds(chain)) {
      // Completed slices are never candidates for relaunch.
      if (chain.completedSliceIds.includes(sliceId)) continue;
      if (chain.sliceStates[sliceId] === "completed") continue;

      const childId = resolveRunningChildJobId(chain, sliceId);
      if (!childId) continue;
      const child = loadJob(cwd, childId);
      if (!child) continue;

      if (TERMINAL_STATUSES.has(child.status)) {
        const advanced = await advance(
          { cwd, child },
          {
            ...options,
            transitionJob: transition,
            readJob: loadJob
          }
        );
        if (!advanced.ignored) recoveredChildIds.push(child.id);
        if (advanced.deliveryCreated) {
          startNotificationDispatch(cwd, {
            spawnNotificationWorker: options.spawnNotificationWorker
          });
        }
        continue;
      }

      if (child.status !== "running") continue;

      if (await ownershipIsHeld(resolveJobWorkerOwnershipKey(cwd, child.id))) {
        continue;
      }

      if (isChildProcessLive(child, isRunning, verify)) {
        continue;
      }

      const summary =
        "Slice worker process is gone after a crash; no live MiMoCode process remains.";
      let terminalChild: JobRecord;
      try {
        const result = await transition(cwd, child.id, {
          status: "stalled",
          summary,
          error: summary,
          errorCode: "worker_lost"
        });
        terminalChild = result.job;
        if (result.deliveryCreated) {
          startNotificationDispatch(cwd, {
            spawnNotificationWorker: options.spawnNotificationWorker
          });
        }
      } catch {
        const raced = loadJob(cwd, child.id);
        if (!raced || !TERMINAL_STATUSES.has(raced.status)) continue;
        terminalChild = raced;
      }

      recoveredChildIds.push(terminalChild.id);
      const advanced = await advance(
        { cwd, child: terminalChild },
        {
          ...options,
          transitionJob: transition,
          readJob: loadJob
        }
      );
      if (advanced.deliveryCreated) {
        startNotificationDispatch(cwd, {
          spawnNotificationWorker: options.spawnNotificationWorker
        });
      }
    }

    const latestChain = (options.listJobChains ?? listJobChains)(cwd)
      .find((entry) => entry.chainId === chain.chainId) ?? chain;
    if (Object.values(latestChain.sliceStates).some((state) => state === "running")) {
      continue;
    }
    const latestRoot = loadJob(cwd, latestChain.rootJobId);
    if (!latestRoot || latestRoot.status !== "running") continue;

    const continued = await continueChain(
      { cwd, chain: latestChain },
      {
        ...options,
        transitionJob: transition,
        readJob: loadJob
      }
    );
    if (continued.startedChildId) recoveredChildIds.push(continued.startedChildId);
    if (continued.deliveryCreated) {
      startNotificationDispatch(cwd, {
        spawnNotificationWorker: options.spawnNotificationWorker
      });
    }
  }

  return { recoveredChildIds };
}

function runningSliceIds(chain: JobChainRecord): string[] {
  return Object.entries(chain.sliceStates)
    .filter(([, state]) => state === "running")
    .map(([sliceId]) => sliceId);
}

function resolveRunningChildJobId(chain: JobChainRecord, sliceId: string): string | undefined {
  if (
    chain.currentSliceId === sliceId &&
    typeof chain.latestContinuationJobId === "string" &&
    chain.latestContinuationJobId.trim()
  ) {
    return chain.latestContinuationJobId;
  }
  return chain.childJobIds[sliceId];
}

function isChildProcessLive(
  child: JobRecord,
  processIsRunning: (pid: number) => boolean,
  verify: (
    pid: number,
    expectedIdentity: string | null | undefined
  ) => ProcessIdentityVerification
): boolean {
  if (typeof child.pid !== "number" || child.pid <= 0) return false;
  if (!processIsRunning(child.pid)) return false;
  if (child.processIdentity == null) return true;
  const verification = verify(child.pid, child.processIdentity);
  return verification.status === "match" || verification.status === "unconfirmed";
}

function defaultProcessIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM";
  }
}
