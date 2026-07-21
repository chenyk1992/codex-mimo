import type { NotificationTarget } from "../notify/types.js";

export type JobStatus =
  | "queued"
  | "running"
  | "needs_input"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export type JobPhase =
  | "starting"
  | "planning"
  | "investigating"
  | "editing"
  | "verifying"
  | "reviewing"
  | "finalizing";

export type JobKind = "plan" | "implement" | "review" | "fix-ci" | "resume" | "compose";

export interface JobReceipt {
  jobId: string;
  kind: JobKind;
  status: "queued";
  actions: {
    status: "mimo_status";
    events: "mimo_events";
    result: "mimo_result";
    cancel: "mimo_cancel";
  };
}

export interface JobVerification {
  command: string;
  exitCode: number | null;
  passed: boolean;
  durationMs?: number;
}

export interface JobReportPaths {
  json?: string;
  markdown?: string;
  eventsJsonl?: string;
  diff?: string;
}

export interface ExecutionCallbackSummary {
  invocationId: string;
  outcome: "completed" | "error" | "cancelled" | "missing";
  sessionId?: string | null;
  receivedAt?: string;
  error?: string;
}

export interface JobTransitionFields {
  status: JobStatus;
  summary: string;
  phase?: JobPhase;
  pid?: number | null;
  processIdentity?: string | null;
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

export interface PendingJobTransition extends JobTransitionFields {
  version: 1;
  stage: "prepared" | "finalized";
  fromStatus: JobStatus;
  signalCursor: number;
  signalCreatedAt: string;
  requestHash: string;
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  cwd: string;
  task: string;
  request: unknown;
  status: JobStatus;
  phase?: JobPhase;
  pid?: number | null;
  processIdentity: string | null;
  cancellationRequestedAt?: string;
  sessionId?: string | null;
  parentJobId?: string | null;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  summary?: string;
  changedFiles: string[];
  verification: JobVerification[];
  executionCallback?: ExecutionCallbackSummary;
  pendingTransition?: PendingJobTransition;
  notificationTarget?: NotificationTarget;
  reportPaths?: JobReportPaths;
  logFile: string;
  eventsFile: string;
  signalsFile: string;
  notificationOutboxFile: string;
  error?: string;
  errorCode?: string;
  lastEventAt?: string;
  lastTool?: string;
  idleTimeoutMs?: number;
}

export interface JobStatusResult {
  jobId: string;
  kind: JobKind;
  parentJobId: string | null;
  status: JobStatus;
  phase?: JobPhase;
  elapsedMs: number | null;
  sessionId: string | null;
  summary: string;
  changedFiles: string[];
  cancellationRequested?: true;
  executionCallback?: ExecutionCallbackSummary;
  progress: string[];
  notification?: JobNotificationStatus;
  actions: {
    events: "mimo_events";
    wait?: "mimo_wait";
    result?: "mimo_result";
    cancel?: "mimo_cancel";
    resume?: "mimo_resume";
  };
}

export interface JobNotificationStatus {
  targetType: "codex" | "webhook";
  status: "pending" | "delivering" | "delivered" | "failed";
  attempts: number;
  lastError?: string;
}

export interface JobResult {
  jobId: string;
  kind: JobKind;
  parentJobId: string | null;
  status: JobStatus;
  resultType: "partial" | "final";
  summary: string;
  sessionId: string | null;
  changedFiles: string[];
  verification: JobVerification[];
  executionCallback?: ExecutionCallbackSummary;
  error?: string;
  errorCode?: string;
  reportPaths?: JobReportPaths;
  notification?: JobNotificationStatus;
  actions: {
    status: "mimo_status";
    events: "mimo_events";
    resume?: "mimo_resume";
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function buildJobId(
  prefix: string,
  now: () => number = () => Date.now(),
  random: () => string = () => Math.random().toString(36).slice(2, 8)
): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "job";
  return `${safePrefix}-${now().toString(36)}-${random()}`;
}

export function isActiveJobStatus(status: JobStatus): boolean {
  return status === "queued" || status === "running";
}
