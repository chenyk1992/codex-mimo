export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type JobPhase =
  | "queued"
  | "starting"
  | "planning"
  | "investigating"
  | "editing"
  | "verifying"
  | "reviewing"
  | "finalizing"
  | "done"
  | "failed"
  | "cancelled";

export type JobKind = "plan" | "implement" | "review" | "fix-ci" | "compose" | "resume" | "acp";

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

export interface JobSignalsHint {
  tool: "mimo_events";
  waitTool: "mimo_wait";
  jobId: string;
  sinceCursor: number;
}

export interface JobWakeHint {
  tool: "mimo_wake";
  jobId: string;
  sinceCursor: number;
}

export interface JobCallbackSummary {
  invocationId: string;
  outcome: "completed" | "error" | "cancelled" | "missing";
  sessionId?: string | null;
  receivedAt?: string;
  error?: string;
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  workflow?: string;
  cwd: string;
  task: string;
  request: unknown;
  status: JobStatus;
  phase: JobPhase;
  pid?: number | null;
  sessionId?: string | null;
  parentJobId?: string | null;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  summary?: string;
  changedFiles: string[];
  verification: JobVerification[];
  callback?: JobCallbackSummary;
  reportPaths?: JobReportPaths;
  logFile: string;
  eventsFile: string;
  signalsFile: string;
  error?: string;
  errorCode?: string;
}

export interface JobLaunchResult {
  jobId: string;
  status: JobStatus;
  phase: JobPhase;
  summary: string;
  actions: {
    status: "mimo_status";
    result: "mimo_result";
    cancel: "mimo_cancel";
  };
  signals: JobSignalsHint;
  wake: JobWakeHint;
}

export interface JobStatusResult {
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  phase: JobPhase;
  elapsedMs: number | null;
  sessionId: string | null;
  summary: string;
  changedFiles: string[];
  callback?: JobCallbackSummary;
  progress: string[];
  signals: JobSignalsHint;
  wake?: JobWakeHint;
  actions: {
    result?: "mimo_result";
    cancel?: "mimo_cancel";
  };
}

export interface JobResult {
  jobId: string;
  status: JobStatus;
  summary: string;
  sessionId: string | null;
  changedFiles: string[];
  verification: JobVerification[];
  callback?: JobCallbackSummary;
  error?: string;
  errorCode?: string;
  reportPaths?: JobReportPaths;
  signals: JobSignalsHint;
  resumeHint?: {
    tool: "mimo_resume_job";
    jobId: string;
  };
  directResumeHint?: {
    tool: "mimo_resume";
    session: string;
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
