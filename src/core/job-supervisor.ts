import path from "node:path";
import { readNotificationDeliveries } from "../notify/dispatcher.js";
import {
  listJobs,
  resolveJobDir
} from "./job-store.js";
import {
  spawnJobWorker,
  spawnNotificationWorker
} from "./job-process.js";
import { isActiveJobStatus, type JobRecord } from "./jobs.js";
import {
  ProcessLockUnavailableError,
  isProcessLockHeld,
  resolveProcessLockEndpoint,
  withProcessLock
} from "./process-lock.js";
import { transitionJob } from "./job-transition.js";
import { runJobWorker } from "./job-worker.js";
import { runNotificationWorker } from "../notify/worker.js";
import { startNotificationDispatch } from "../notify/dispatch-process.js";
import type { NotificationDelivery } from "../notify/types.js";
import {
  resolveJobWorkerOwnershipKey,
  resolveNotificationWorkerOwnershipKey
} from "./worker-ownership.js";

const DEFAULT_POLL_INTERVAL_MS = 100;
const OWNERSHIP_HANDOFF_TIMEOUT_MS = 250;
const DEFAULT_MAX_WORKER_START_FAILURES = 3;

export interface JobSupervisorDependencies {
  listJobs?: typeof listJobs;
  readNotificationDeliveries?: typeof readNotificationDeliveries;
  spawnJobWorker?: typeof spawnJobWorker;
  spawnNotificationWorker?: typeof spawnNotificationWorker;
  processIsRunning?: (pid: number) => boolean;
  workerOwnershipIsHeld?: typeof isProcessLockHeld;
  transitionJob?: typeof transitionJob;
  runJobWorker?: typeof runJobWorker;
  runNotificationWorker?: typeof runNotificationWorker;
  sleep?: (delayMs: number) => Promise<void>;
  pollIntervalMs?: number;
  maxWorkerStartFailures?: number;
}

export async function runJobSupervisor(
  cwd: string,
  dependencies: JobSupervisorDependencies = {}
): Promise<void> {
  const ownershipKey = path.join(resolveJobDir(cwd), "supervisor-ownership");
  const endpoint = resolveProcessLockEndpoint(ownershipKey);
  while (true) {
    try {
      await withProcessLock(
        ownershipKey,
        () => runOwnedSupervisor(cwd, dependencies),
        { timeoutMs: OWNERSHIP_HANDOFF_TIMEOUT_MS }
      );
      return;
    } catch (error) {
      if (!(error instanceof ProcessLockUnavailableError) ||
          error.key !== ownershipKey ||
          error.endpoint.host !== endpoint.host ||
          error.endpoint.port !== endpoint.port) {
        throw error;
      }
      if (!hasUnfinishedWork(cwd, dependencies)) return;
    }
  }
}

function hasUnfinishedWork(
  cwd: string,
  dependencies: JobSupervisorDependencies
): boolean {
  const readJobs = dependencies.listJobs ?? listJobs;
  if (readJobs(cwd).some(isSupervisedJob)) return true;
  const readDeliveries = dependencies.readNotificationDeliveries ?? readNotificationDeliveries;
  return readDeliveries(cwd).some(isDeliveryUnfinished);
}

async function runOwnedSupervisor(
  cwd: string,
  dependencies: JobSupervisorDependencies
): Promise<void> {
  const readJobs = dependencies.listJobs ?? listJobs;
  const readDeliveries = dependencies.readNotificationDeliveries ?? readNotificationDeliveries;
  const startJobWorker = dependencies.spawnJobWorker ?? spawnJobWorker;
  const startNotificationWorker = dependencies.spawnNotificationWorker ?? spawnNotificationWorker;
  const isRunning = dependencies.processIsRunning ?? processIsRunning;
  const ownershipIsHeld = dependencies.workerOwnershipIsHeld ?? isProcessLockHeld;
  const sleep = dependencies.sleep ?? defaultSleep;
  const pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxStartFailures = positiveIntegerOr(
    dependencies.maxWorkerStartFailures,
    DEFAULT_MAX_WORKER_START_FAILURES
  );
  const jobWorkers = new Map<string, number>();
  const jobStartFailures = new Map<string, number>();
  const jobProgress = new Map<string, string>();
  let notificationWorker: number | undefined;
  let notificationStartFailures = 0;
  let notificationProgress: string | undefined;

  while (true) {
    const supervisedJobs = readJobs(cwd).filter(isSupervisedJob);
    const supervisedIds = new Set(supervisedJobs.map((job) => job.id));
    for (const jobId of jobWorkers.keys()) {
      if (!supervisedIds.has(jobId)) jobWorkers.delete(jobId);
    }
    for (const jobId of jobStartFailures.keys()) {
      if (!supervisedIds.has(jobId)) jobStartFailures.delete(jobId);
    }
    for (const jobId of jobProgress.keys()) {
      if (!supervisedIds.has(jobId)) jobProgress.delete(jobId);
    }
    for (const job of supervisedJobs) {
      const progress = durableJobProgress(job);
      const previousProgress = jobProgress.get(job.id);
      if (previousProgress !== undefined && previousProgress !== progress) {
        jobStartFailures.delete(job.id);
      }
      jobProgress.set(job.id, progress);
      if (await ownershipIsHeld(resolveJobWorkerOwnershipKey(cwd, job.id))) {
        continue;
      }
      const pid = jobWorkers.get(job.id);
      if (pid !== undefined && isRunning(pid)) continue;
      if (pid !== undefined) {
        jobWorkers.delete(job.id);
        jobStartFailures.set(job.id, (jobStartFailures.get(job.id) ?? 0) + 1);
      }
      if ((jobStartFailures.get(job.id) ?? 0) >= maxStartFailures) {
        await settleJobWorkerStartFailure(cwd, job, dependencies);
        jobStartFailures.delete(job.id);
        continue;
      }
      const replacement = trySpawn(() => startJobWorker(cwd, job.id));
      if (replacement !== undefined) {
        jobWorkers.set(job.id, replacement);
        continue;
      }
      const failures = (jobStartFailures.get(job.id) ?? 0) + 1;
      jobStartFailures.set(job.id, failures);
      if (failures >= maxStartFailures) {
        await settleJobWorkerStartFailure(cwd, job, dependencies);
        jobStartFailures.delete(job.id);
      }
    }

    const unfinishedDeliveries = readDeliveries(cwd).filter(isDeliveryUnfinished);
    if (unfinishedDeliveries.length > 0) {
      const progress = durableNotificationProgress(unfinishedDeliveries);
      if (notificationProgress !== undefined && notificationProgress !== progress) {
        notificationStartFailures = 0;
      }
      notificationProgress = progress;
      if (await ownershipIsHeld(resolveNotificationWorkerOwnershipKey(cwd))) {
        // The active owner gets a chance to make durable delivery progress.
      } else if (notificationWorker === undefined || !isRunning(notificationWorker)) {
        if (notificationWorker !== undefined) {
          notificationWorker = undefined;
          notificationStartFailures += 1;
        }
        if (notificationStartFailures >= maxStartFailures) {
          await (dependencies.runNotificationWorker ?? runNotificationWorker)(cwd);
          notificationStartFailures = 0;
        } else {
          notificationWorker = trySpawn(() => startNotificationWorker(cwd));
          if (notificationWorker === undefined) {
            notificationStartFailures += 1;
            if (notificationStartFailures >= maxStartFailures) {
              await (dependencies.runNotificationWorker ?? runNotificationWorker)(cwd);
              notificationStartFailures = 0;
            }
          }
        }
      }
    } else {
      notificationWorker = undefined;
      notificationStartFailures = 0;
      notificationProgress = undefined;
    }

    if (supervisedJobs.length === 0 && unfinishedDeliveries.length === 0) return;
    await sleep(pollIntervalMs);
  }
}

async function settleJobWorkerStartFailure(
  cwd: string,
  job: JobRecord,
  dependencies: JobSupervisorDependencies
): Promise<void> {
  if (job.status !== "queued") {
    await (dependencies.runJobWorker ?? runJobWorker)(cwd, job.id);
    return;
  }
  const message = "Job worker could not start after bounded retries.";
  const result = await (dependencies.transitionJob ?? transitionJob)(cwd, job.id, {
    status: "failed",
    summary: message,
    error: message,
    errorCode: "worker_spawn_failed"
  });
  if (result.deliveryCreated) {
    startNotificationDispatch(cwd, {
      spawnNotificationWorker: dependencies.spawnNotificationWorker
    });
  }
}

function isSupervisedJob(job: JobRecord): boolean {
  return isActiveJobStatus(job.status) || job.pendingTransition !== undefined;
}

function isDeliveryUnfinished(delivery: { status: string }): boolean {
  return delivery.status === "pending" || delivery.status === "delivering";
}

function durableJobProgress(job: JobRecord): string {
  return JSON.stringify({
    status: job.status,
    phase: job.phase ?? null,
    pid: job.pid ?? null,
    processIdentity: job.processIdentity ?? null,
    updatedAt: job.updatedAt,
    pendingTransition: job.pendingTransition?.requestHash ?? null
  });
}

function durableNotificationProgress(deliveries: readonly NotificationDelivery[]): string {
  return JSON.stringify(deliveries.map((delivery) => ({
    id: delivery.id,
    status: delivery.status,
    attempts: delivery.attempts,
    nextAttemptAt: delivery.nextAttemptAt ?? null,
    leaseUntil: delivery.leaseUntil ?? null
  })).sort((left, right) => left.id.localeCompare(right.id)));
}

function trySpawn(spawn: () => number): number | undefined {
  try {
    const pid = spawn();
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrorWithCode(error, "EPERM");
  }
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback;
}
