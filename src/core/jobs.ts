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
  reportPaths?: JobReportPaths;
  logFile: string;
  eventsFile: string;
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
  progress: string[];
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
  error?: string;
  errorCode?: string;
  reportPaths?: JobReportPaths;
  resumeHint?: {
    tool: "mimo_resume_job";
    jobId: string;
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
