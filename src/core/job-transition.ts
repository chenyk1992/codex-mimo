import {
  appendJobSignal,
  appendJobSignalAtCursor,
  isAttentionSignal,
  readJobSignals,
  type AttentionSignalKind,
  type JobSignal,
  type JobSignalKind,
  type JobSignalLevel,
  type NewJobSignal
} from "./job-signals.js";
import {
  finalizePendingJobTransition,
  readJob,
  resolveJobPaths,
  savePendingJobTransition
} from "./job-store.js";
import {
  nowIso,
  type JobRecord,
  type JobStatus,
  type JobTransitionFields,
  type PendingJobTransition
} from "./jobs.js";
import { withFileLock } from "./file-lock.js";
import { enqueueDelivery as enqueueNotificationDelivery } from "../notify/outbox.js";

const LEGAL: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["needs_input", "blocked", "completed", "failed", "cancelled", "timeout"],
  needs_input: [],
  blocked: [],
  completed: [],
  failed: [],
  cancelled: [],
  timeout: []
};

export interface JobTransition extends JobTransitionFields {}

export interface JobTransitionResult {
  job: JobRecord;
  signal: JobSignal;
  deliveryCreated: boolean;
}

export interface JobTransitionDependencies {
  afterIntentPersisted?: () => void;
  appendSignal?: typeof appendJobSignalAtCursor;
  enqueueDelivery?: typeof enqueueNotificationDelivery;
  beforeFinalCommit?: () => void;
}

type ProgressSignalKind = Exclude<JobSignalKind, AttentionSignalKind>;

export type JobProgress = Omit<NewJobSignal, "jobId" | "kind" | "status"> & {
  kind: ProgressSignalKind;
};

export function transitionJob(
  cwd: string,
  jobId: string,
  transition: JobTransition,
  dependencies: JobTransitionDependencies = {}
): JobTransitionResult {
  return withFileLock(resolveJobStateLock(cwd, jobId), () => {
    let existing = requireJob(cwd, jobId);
    if (existing.pendingTransition) {
      const sameRequest = pendingMatchesRequest(existing.pendingTransition, transition);
      const recovered = applyPendingTransition(cwd, existing, existing.pendingTransition, dependencies);
      if (sameRequest) return recovered;
      existing = recovered.job;
    }

    if (!LEGAL[existing.status].includes(transition.status)) {
      throw new Error(`Illegal job transition ${existing.status} -> ${transition.status}`);
    }

    const pending = buildPendingTransition(existing, transition);
    const intentJob = savePendingJobTransition(cwd, jobId, pending);
    dependencies.afterIntentPersisted?.();
    return applyPendingTransition(cwd, intentJob, pending, dependencies);
  });
}

export function appendJobProgress(cwd: string, jobId: string, progress: JobProgress): JobSignal {
  if (isAttentionSignal(progress as Pick<JobSignal, "kind">)) {
    throw new Error(`Attention signal ${progress.kind} must be written by transitionJob`);
  }
  return withFileLock(resolveJobStateLock(cwd, jobId), () => {
    let job = requireJob(cwd, jobId);
    if (job.pendingTransition) {
      job = applyPendingTransition(cwd, job, job.pendingTransition, {}).job;
    }
    return appendJobSignal(job.signalsFile, { ...progress, jobId });
  });
}

export function recoverPendingTransition(
  cwd: string,
  jobId: string,
  dependencies: JobTransitionDependencies = {}
): JobTransitionResult | undefined {
  return withFileLock(resolveJobStateLock(cwd, jobId), () => {
    const job = requireJob(cwd, jobId);
    if (!job.pendingTransition) return undefined;
    return applyPendingTransition(cwd, job, job.pendingTransition, dependencies);
  });
}

function applyPendingTransition(
  cwd: string,
  job: JobRecord,
  pending: PendingJobTransition,
  dependencies: JobTransitionDependencies
): JobTransitionResult {
  const appendSignal = dependencies.appendSignal ?? appendJobSignalAtCursor;
  const signal = appendSignal(job.signalsFile, pending.signalCursor, {
    jobId: job.id,
    kind: transitionSignalKind(pending.status),
    level: signalLevel(pending.status),
    status: pending.status,
    createdAt: pending.signalCreatedAt,
    ...(pending.phase ? { phase: pending.phase } : {}),
    summary: pending.summary,
    ...(pending.reportPaths ? { reportPaths: pending.reportPaths } : {})
  });

  let deliveryCreated = false;
  if (job.notificationTarget && isAttentionSignal(signal)) {
    const enqueueDelivery = dependencies.enqueueDelivery ?? enqueueNotificationDelivery;
    deliveryCreated = enqueueDelivery(job.notificationOutboxFile, {
      jobId: job.id,
      signalCursor: signal.cursor,
      target: job.notificationTarget,
      createdAt: signal.createdAt
    }).created;
  }

  dependencies.beforeFinalCommit?.();
  const finalized = finalizePendingJobTransition(cwd, job.id, pending);
  return { job: finalized, signal, deliveryCreated };
}

function buildPendingTransition(
  job: JobRecord,
  transition: JobTransition
): PendingJobTransition {
  const timestamp = nowIso();
  const running = transition.status === "running";
  return {
    version: 1,
    fromStatus: job.status,
    signalCursor: readJobSignals(job.signalsFile).nextCursor + 1,
    signalCreatedAt: timestamp,
    status: transition.status,
    summary: transition.summary,
    phase: running ? transition.phase : undefined,
    pid: running ? (transition.pid ?? job.pid ?? null) : null,
    ...(running
      ? { startedAt: transition.startedAt ?? job.startedAt ?? timestamp }
      : { completedAt: transition.completedAt ?? timestamp }),
    ...(transition.sessionId !== undefined ? { sessionId: transition.sessionId } : {}),
    ...(transition.changedFiles !== undefined ? { changedFiles: transition.changedFiles } : {}),
    ...(transition.verification !== undefined ? { verification: transition.verification } : {}),
    ...(transition.executionCallback !== undefined
      ? { executionCallback: transition.executionCallback }
      : {}),
    ...(transition.reportPaths !== undefined ? { reportPaths: transition.reportPaths } : {}),
    ...(transition.error !== undefined ? { error: transition.error } : {}),
    ...(transition.errorCode !== undefined ? { errorCode: transition.errorCode } : {})
  };
}

function requireJob(cwd: string, jobId: string): JobRecord {
  const job = readJob(cwd, jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  return job;
}

function pendingMatchesRequest(
  pending: PendingJobTransition,
  transition: JobTransition
): boolean {
  return pending.status === transition.status && pending.summary === transition.summary;
}

function resolveJobStateLock(cwd: string, jobId: string): string {
  const paths = resolveJobPaths(cwd, jobId);
  return `${paths.jobFile.slice(0, -".json".length)}.state.lock`;
}

function signalLevel(status: JobStatus): JobSignalLevel {
  if (status === "failed") return "error";
  if (status === "needs_input" || status === "blocked" || status === "timeout") return "warn";
  return "info";
}

function transitionSignalKind(status: JobStatus): JobSignalKind {
  if (status === "running") return "phase_changed";
  if (status === "queued") throw new Error("A job cannot transition to queued");
  return status;
}
