import { execa } from "execa";
import {
  ComposeInput,
  FixCiInput,
  HealthcheckInput,
  ImplementInput,
  JobCancelInput,
  JobEventsInput,
  JobListInput,
  JobResultInput,
  JobStatusInput,
  JobWaitInput,
  PlanInput,
  ResumeInput,
  ReviewInput
} from "./tool-schemas.js";
import { launchJob, type LaunchJobDependencies } from "../core/job-launcher.js";
import { bindJobDefinition } from "../core/job-definitions.js";
import { listJobs, readJob, resolveJobPaths } from "../core/job-store.js";
import { recoverStaleQueuedJobs } from "../core/job-recovery.js";
import {
  spawnNotificationWorker,
  terminateOwnedJobProcess,
  type OwnedProcessTermination
} from "../core/job-process.js";
import type { JobNotificationStatus, JobRecord } from "../core/jobs.js";
import { renderJobResult, renderJobStatus } from "../core/job-render.js";
import { readRecentJobLogLines } from "../core/job-log.js";
import {
  isAttentionSignal,
  readJobSignalPage,
  type JobSignalReadResult
} from "../core/job-signals.js";
import { requestJobCancellation, transitionJob } from "../core/job-transition.js";
import { ProcessLockUnavailableError, withProcessLock } from "../core/process-lock.js";
import { resolveMimoCommand } from "../mimo/run-json.js";
import {
  readNotificationDeliveries,
  summarizeJobNotification
} from "../notify/dispatcher.js";
import type { NotificationDelivery } from "../notify/types.js";

const WAIT_CHECK_INTERVAL_MS = 1_000;

export async function mimoHealthcheck(input: unknown) {
  const parsed = HealthcheckInput.parse(input);
  const cwd = parsed.cwd ?? process.cwd();
  try {
    const result = await execa(resolveMimoCommand(), ["--version"], { cwd });
    return { ok: true, version: result.stdout.trim(), cwd };
  } catch {
    return { ok: false, error: "mimo not found or not working", cwd };
  }
}

export async function mimoPlan(input: unknown, deps: LaunchJobDependencies = {}) {
  const parsed = PlanInput.parse(input);
  const { notify, ...request } = parsed;
  return launchJob({ kind: "plan", cwd: parsed.cwd, task: parsed.task, request, notify }, deps);
}

export async function mimoImplement(input: unknown, deps: LaunchJobDependencies = {}) {
  const parsed = ImplementInput.parse(input);
  const { notify, ...request } = parsed;
  return launchJob({ kind: "implement", cwd: parsed.cwd, task: parsed.task, request, notify }, deps);
}

export async function mimoReview(input: unknown, deps: LaunchJobDependencies = {}) {
  const parsed = ReviewInput.parse(input);
  const { notify, ...request } = parsed;
  return launchJob({
    kind: "review",
    cwd: parsed.cwd,
    task: `Review changes since ${parsed.base}.`,
    request,
    notify
  }, deps);
}

export async function mimoFixCi(input: unknown, deps: LaunchJobDependencies = {}) {
  const parsed = FixCiInput.parse(input);
  const { notify, ...request } = parsed;
  return launchJob({
    kind: "fix-ci",
    cwd: parsed.cwd,
    task: parsed.task ?? "Fix the CI failures shown in the attached log.",
    request,
    notify
  }, deps);
}

export async function mimoCompose(input: unknown, deps: LaunchJobDependencies = {}) {
  const parsed = ComposeInput.parse(input);
  const { notify, ...request } = parsed;
  return launchJob({
    kind: "compose",
    cwd: parsed.cwd,
    task: parsed.task ?? `Run ${parsed.workflow} workflow.`,
    request,
    notify
  }, deps);
}

export async function mimoResume(input: unknown, deps: LaunchJobDependencies = {}) {
  const parsed = ResumeInput.parse(input);
  const parent = readJob(parsed.cwd, parsed.jobId);
  if (!parent) throw new Error(`No job found for ${parsed.jobId}.`);
  if (parent.status !== "needs_input" && parent.status !== "blocked") {
    throw new Error(`Job ${parent.id} must be needs_input or blocked before it can be resumed.`);
  }
  if (!parent.sessionId) {
    throw new Error(`Job ${parent.id} does not have a sessionId and cannot be resumed.`);
  }
  const executionPolicy = bindJobDefinition(parent).executionPolicy;

  const { notify, ...options } = parsed;
  return launchJob({
    kind: "resume",
    cwd: parsed.cwd,
    task: parsed.task,
    parentJobId: parent.id,
    request: { ...options, sessionId: parent.sessionId, executionPolicy },
    ...(notify === undefined
      ? { notificationTarget: parent.notificationTarget ?? null }
      : { notify })
  }, deps);
}

export async function mimoStatus(input: unknown) {
  const parsed = JobStatusInput.parse(input);
  const job = parsed.jobId ? readJob(parsed.cwd, parsed.jobId) : listJobs(parsed.cwd)[0];
  if (!job) throw new Error("No jobs recorded for this workspace.");
  return renderJobStatus(job, {
    progress: readRecentJobLogLines(job.logFile, 5),
    notification: notificationStatus(job)
  });
}

export async function mimoEvents(input: unknown) {
  const parsed = JobEventsInput.parse(input);
  const job = resolveJobForSignals(parsed.cwd, parsed.jobId);
  return renderJobSignals(job, readJobSignalPage(job.signalsFile, {
    sinceCursor: parsed.sinceCursor,
    limit: parsed.limit,
    minLevel: parsed.minLevel
  }));
}

export interface MimoWaitDependencies {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  intervalMs?: number;
  readSignals?: typeof readAttentionSignals;
}

export async function mimoWait(input: unknown, deps: MimoWaitDependencies = {}) {
  const parsed = JobWaitInput.parse(input);
  const selected = resolveJobForSignals(parsed.cwd, parsed.jobId);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? delay;
  const intervalMs = deps.intervalMs ?? WAIT_CHECK_INTERVAL_MS;
  const readSignals = deps.readSignals ?? readAttentionSignals;
  const startedAt = now();
  const deadline = startedAt + parsed.timeoutMs;
  let job = selected;
  let scanCursor = parsed.sinceCursor;
  let result = readSignals(job, { ...parsed, sinceCursor: scanCursor });

  while (result.signals.length === 0 && now() < deadline) {
    scanCursor = result.nextCursor;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - now())));
    job = readJob(parsed.cwd, selected.id) ?? job;
    result = readSignals(job, { ...parsed, sinceCursor: scanCursor });
  }

  if (result.signals.length === 0) scanCursor = result.nextCursor;
  const visibleResult = result.signals.length === 0
    ? { signals: [], nextCursor: scanCursor }
    : result;

  return {
    ...renderJobSignals(job, visibleResult),
    timedOut: result.signals.length === 0,
    waitedMs: Math.max(0, now() - startedAt)
  };
}

export async function mimoResult(input: unknown) {
  const parsed = JobResultInput.parse(input);
  const job = parsed.jobId
    ? readJob(parsed.cwd, parsed.jobId)
    : listJobs(parsed.cwd).find((candidate) => isResultStatus(candidate.status));
  if (!job) {
    throw new Error(parsed.jobId
      ? `No job found for ${parsed.jobId}.`
      : "No job results recorded for this workspace.");
  }
  if (!isResultStatus(job.status)) {
    throw new Error(`Job result is not available while ${job.id} is ${job.status}.`);
  }
  return renderJobResult(job, notificationStatus(job));
}

export interface MimoJobsDependencies {
  recoverStaleQueuedJobs?: typeof recoverStaleQueuedJobs;
}

export async function mimoJobs(input: unknown, deps: MimoJobsDependencies = {}) {
  const parsed = JobListInput.parse(input);
  await (deps.recoverStaleQueuedJobs ?? recoverStaleQueuedJobs)(parsed.cwd);
  const jobs = listJobs(parsed.cwd);
  const deliveries = readNotificationDeliveries(parsed.cwd);
  return (parsed.all ? jobs : jobs.slice(0, 8)).map((job) => renderJobStatus(job, {
    progress: readRecentJobLogLines(job.logFile, 3),
    notification: notificationStatus(job, deliveries)
  }));
}

export interface MimoCancelDependencies {
  transitionJob?: typeof transitionJob;
  terminateProcess?: (
    pid: number | null | undefined,
    processIdentity: string | null | undefined
  ) => OwnedProcessTermination;
  spawnNotificationWorker?: typeof spawnNotificationWorker;
  requestJobCancellation?: typeof requestJobCancellation;
  waitForCancellation?: (cwd: string, jobId: string) => Promise<JobRecord>;
}

export async function mimoCancel(input: unknown, deps: MimoCancelDependencies = {}) {
  const parsed = JobCancelInput.parse(input);
  const existing = readJob(parsed.cwd, parsed.jobId);
  if (!existing) throw new Error(`No job found for ${parsed.jobId}.`);
  if (existing.status === "cancelled") {
    return renderJobResult(existing, notificationStatus(existing));
  }
  if (existing.status !== "queued" && existing.status !== "running") {
    throw new Error(`Job ${existing.id} cannot be cancelled while ${existing.status}.`);
  }

  const requested = await (deps.requestJobCancellation ?? requestJobCancellation)(
    parsed.cwd,
    existing.id
  );
  if (requested.status === "cancelled") {
    return renderJobResult(requested, notificationStatus(requested));
  }
  if (requested.status !== "queued" && requested.status !== "running") {
    throw new Error(`Job ${requested.id} cannot be cancelled while ${requested.status}.`);
  }

  let transitioned;
  try {
    transitioned = await withProcessLock(
      `${resolveJobPaths(parsed.cwd, existing.id).jobFile}.worker-ownership`,
      async () => {
        const current = readJob(parsed.cwd, existing.id);
        if (!current) throw new Error(`No job found for ${existing.id}.`);
        if (current.status === "cancelled") return undefined;
        if (current.status !== "queued" && current.status !== "running") {
          throw new Error(`Job ${current.id} cannot be cancelled while ${current.status}.`);
        }
        if (current.status === "running" && current.pid !== null) {
          const termination = (deps.terminateProcess ?? terminateOwnedJobProcess)(
            current.pid,
            current.processIdentity
          );
          if (termination.status === "unconfirmed") {
            throw new Error(
              `Cancellation could not be confirmed for ${current.id}: ${termination.evidence}`
            );
          }
        }
        return (deps.transitionJob ?? transitionJob)(parsed.cwd, current.id, {
          status: "cancelled",
          summary: `Cancelled ${current.id}.`,
          errorCode: "cancelled"
        });
      },
      { timeoutMs: 0 }
    );
  } catch (error) {
    if (error instanceof ProcessLockUnavailableError) {
      const pending = await (deps.waitForCancellation ?? waitForCancellation)(
        parsed.cwd,
        existing.id
      );
      if (pending.status === "cancelled") {
        return renderJobResult(pending, notificationStatus(pending));
      }
      return renderJobStatus(pending, {
        progress: readRecentJobLogLines(pending.logFile, 3),
        notification: notificationStatus(pending)
      });
    }
    const raced = readJob(parsed.cwd, existing.id);
    if (raced?.status === "cancelled") {
      return renderJobResult(raced, notificationStatus(raced));
    }
    throw error;
  }

  if (!transitioned) {
    const cancelled = readJob(parsed.cwd, existing.id);
    if (!cancelled || cancelled.status !== "cancelled") {
      throw new Error(`Cancellation did not finalize ${existing.id}.`);
    }
    return renderJobResult(cancelled, notificationStatus(cancelled));
  }

  if (transitioned.deliveryCreated) {
    try {
      (deps.spawnNotificationWorker ?? spawnNotificationWorker)(parsed.cwd);
    } catch {
      // The durable outbox remains available for recovery by the next notification worker.
    }
  }
  return renderJobResult(transitioned.job, notificationStatus(transitioned.job));
}

async function waitForCancellation(cwd: string, jobId: string): Promise<JobRecord> {
  const deadline = Date.now() + 250;
  while (true) {
    const job = readJob(cwd, jobId);
    if (!job) throw new Error(`No job found for ${jobId}.`);
    if (job.status !== "running" || !job.cancellationRequestedAt || Date.now() >= deadline) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function resolveJobForSignals(cwd: string, jobId?: string): JobRecord {
  const job = jobId ? readJob(cwd, jobId) : listJobs(cwd)[0];
  if (!job) {
    throw new Error(jobId ? `No job found for ${jobId}.` : "No jobs recorded for this workspace.");
  }
  return job;
}

function readAttentionSignals(
  job: JobRecord,
  options: { sinceCursor: number; limit: number; minLevel: "debug" | "info" | "warn" | "error" }
) {
  return readJobSignalPage(job.signalsFile, {
    sinceCursor: options.sinceCursor,
    minLevel: options.minLevel,
    limit: options.limit,
    include: isAttentionSignal
  });
}

function renderJobSignals(job: JobRecord, result: JobSignalReadResult) {
  const canCancel = job.status === "queued" || job.status === "running";
  const canReadResult = isResultStatus(job.status);
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    ...(job.phase ? { phase: job.phase } : {}),
    nextCursor: result.nextCursor,
    signals: result.signals,
    actions: {
      status: "mimo_status" as const,
      ...(canCancel ? { cancel: "mimo_cancel" as const } : {}),
      ...(canReadResult ? { result: "mimo_result" as const } : {}),
      ...(job.status === "needs_input" || job.status === "blocked"
        ? { resume: "mimo_resume" as const }
        : {})
    }
  };
}

function notificationStatus(
  job: JobRecord,
  deliveries?: readonly NotificationDelivery[]
): JobNotificationStatus | undefined {
  if (!job.notificationTarget) return undefined;
  const summary = summarizeJobNotification(job, deliveries ?? readNotificationDeliveries(job.cwd));
  if (!summary) return undefined;
  return {
    targetType: summary.type,
    status: summary.status,
    attempts: summary.attempts,
    ...(summary.lastError === undefined ? {} : { lastError: summary.lastError })
  };
}

function isResultStatus(status: JobRecord["status"]): boolean {
  return status !== "queued" && status !== "running";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
