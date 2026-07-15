import {
  appendJobSignal,
  isAttentionSignal,
  type AttentionSignalKind,
  type JobSignal,
  type JobSignalKind,
  type JobSignalLevel,
  type NewJobSignal
} from "./job-signals.js";
import { readJob, updateJob } from "./job-store.js";
import {
  nowIso,
  type ExecutionCallbackSummary,
  type JobPhase,
  type JobRecord,
  type JobReportPaths,
  type JobStatus,
  type JobVerification
} from "./jobs.js";
import { enqueueDelivery } from "../notify/outbox.js";

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

export interface JobTransition {
  status: JobStatus;
  summary: string;
  phase?: JobPhase;
  pid?: number | null;
  startedAt?: string;
  completedAt?: string;
  sessionId?: string | null;
  changedFiles?: string[];
  verification?: JobVerification[];
  executionCallback?: ExecutionCallbackSummary;
  reportPaths?: JobReportPaths;
  error?: string;
  errorCode?: string;
}

export interface JobTransitionResult {
  job: JobRecord;
  signal: JobSignal;
  deliveryCreated: boolean;
}

type ProgressSignalKind = Exclude<JobSignalKind, AttentionSignalKind>;

export type JobProgress = Omit<NewJobSignal, "jobId" | "kind" | "status"> & {
  kind: ProgressSignalKind;
};

export function transitionJob(
  cwd: string,
  jobId: string,
  transition: JobTransition
): JobTransitionResult {
  const existing = readJob(cwd, jobId);
  if (!existing) throw new Error(`Job not found: ${jobId}`);
  if (!LEGAL[existing.status].includes(transition.status)) {
    throw new Error(`Illegal job transition ${existing.status} -> ${transition.status}`);
  }

  const timestamp = nowIso();
  const running = transition.status === "running";
  const job = updateJob(cwd, jobId, {
    status: transition.status,
    summary: transition.summary,
    phase: running ? transition.phase : undefined,
    pid: running ? (transition.pid ?? existing.pid ?? null) : null,
    ...(running
      ? { startedAt: transition.startedAt ?? existing.startedAt ?? timestamp }
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
  });

  const signal = appendJobSignal(job.signalsFile, {
    jobId,
    kind: transitionSignalKind(transition.status),
    level: signalLevel(transition.status),
    status: transition.status,
    ...(job.phase ? { phase: job.phase } : {}),
    summary: transition.summary,
    ...(transition.reportPaths ? { reportPaths: transition.reportPaths } : {})
  });

  let deliveryCreated = false;
  if (job.notificationTarget && isAttentionSignal(signal)) {
    deliveryCreated = enqueueDelivery(job.notificationOutboxFile, {
      jobId,
      signalCursor: signal.cursor,
      target: job.notificationTarget,
      createdAt: signal.createdAt
    }).created;
  }

  return { job, signal, deliveryCreated };
}

export function appendJobProgress(cwd: string, jobId: string, progress: JobProgress): JobSignal {
  if (isAttentionSignal(progress as Pick<JobSignal, "kind">)) {
    throw new Error(`Attention signal ${progress.kind} must be written by transitionJob`);
  }
  const job = readJob(cwd, jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  return appendJobSignal(job.signalsFile, { ...progress, jobId });
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
