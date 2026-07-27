import type { NotificationErrorCode, NotificationTarget } from "../notify/types.js";
import type { JobFailureCause, VerificationFailureKind } from "./safety-contracts.js";

export type {
  JobFailureCause,
  JobFailureCauseStage,
  SafetyErrorCode,
  VerificationFailureKind
} from "./safety-contracts.js";

export type JobStatus =
  | "queued"
  | "running"
  | "needs_input"
  | "blocked"
  | "stalled"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export type EffectiveProgressKind =
  | "tool_start"
  | "tool_finish"
  | "file_change"
  | "phase_change"
  | "verification"
  | "callback"
  | "slice_complete";

export type JobPhase =
  | "starting"
  | "planning"
  | "investigating"
  | "editing"
  | "verifying"
  | "reviewing"
  | "finalizing";

export type JobKind = "plan" | "implement" | "review" | "fix-ci" | "resume" | "compose";

export type BatchMode = "auto" | "single" | "sliced";

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

export type JobOutputLevel = "compact" | "standard" | "full";

export type AcceptanceStage = "build" | "test" | "diff_check";
export type AcceptanceOutcome = "passed" | "failed" | "not_applicable";

export interface JobAcceptanceStageSnapshot {
  stage: AcceptanceStage;
  outcome: AcceptanceOutcome | "pending";
  command?: string;
}

export interface JobAcceptanceSummary {
  stages: JobAcceptanceStageSnapshot[];
  failedStage?: AcceptanceStage;
  failedCommand?: string;
  failedTests?: string[];
  suggestion?: string;
}

export interface JobVerification {
  /** Actual executed command line. */
  command: string;
  /** Caller-requested command before wrapper resolution (optional). */
  requestedCommand?: string;
  exitCode: number | null;
  passed: boolean;
  durationMs?: number;
  failureKind?: VerificationFailureKind;
}

export interface JobReportPaths {
  json?: string;
  markdown?: string;
  eventsJsonl?: string;
  diff?: string;
  result?: string;
  plan?: string;
  verification?: string;
  checkpoint?: string;
  slices?: string;
}

export interface CompactAcceptanceResult {
  stage: AcceptanceStage;
  command: string;
  outcome: AcceptanceOutcome;
}

export interface CompactFailure {
  code: string;
  reason: string;
  failedStage?: AcceptanceStage;
  failedCommand?: string;
  failedTests?: string[];
  suggestion?: string;
  /** Primary cause first; compact surfaces truncate to COMPACT_FAILURE_CAUSE_LIMIT. */
  causes?: JobFailureCause[];
}

export interface CompactAttention {
  kind: "needs_input" | "blocked" | "stalled" | "timeout" | "resumable_failure";
  reason: string;
  lastCommand?: string;
  resume?: {
    tool: "mimo_resume";
    jobId: string;
  };
}

export interface CompactJobResult {
  status: JobStatus;
  changedFiles: string[];
  tests: CompactAcceptanceResult[];
  failure: CompactFailure | null;
  reportPath: string | null;
  summary?: string;
  attention?: CompactAttention;
}

export interface JobVerificationDetails extends JobVerification {
  stdout: string;
  stderr: string;
}

export interface StandardJobResult extends CompactJobResult {
  jobId: string;
  kind: JobKind;
  parentJobId: string | null;
  resultType: "partial" | "final";
  summary: string;
  phase?: JobPhase;
  elapsedMs: number | null;
  sessionId: string | null;
  keyError?: string;
  completedSlices?: number;
  remainingSlices?: number;
  incomplete?: string[];
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

export interface FullArtifactTooLarge {
  code: "artifact_too_large";
  artifact: "output" | "plan" | "verification" | "job_log" | "diff";
  path: string;
  bytes: number;
}

export interface FullJobResult extends StandardJobResult {
  output?: string;
  plan?: string;
  verificationDetails?: JobVerificationDetails[];
  jobLog?: string;
  diff?: string;
  artifactErrors?: FullArtifactTooLarge[];
}

export interface CompactJobStatus {
  status: JobStatus;
  resultAvailable?: true;
}

export type RenderedJobResult = CompactJobResult | StandardJobResult | FullJobResult;
export type RenderedJobStatus = CompactJobStatus | JobStatusResult;

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
  acceptance?: JobAcceptanceSummary;
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
  chainId?: string | null;
  sliceId?: string | null;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  summary?: string;
  changedFiles: string[];
  verification: JobVerification[];
  acceptance?: JobAcceptanceSummary;
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
  lastActivityAt?: string;
  lastProgressAt?: string;
  lastProgressKind?: EffectiveProgressKind;
  lastProgressFingerprint?: string;
  lastCommand?: string;
  lastTool?: string;
  idleTimeoutMs?: number;
  progressWarningMs?: number;
  progressTimeoutMs?: number;
  quietSince?: string;
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
  lastEventAt?: string | null;
  idleMs?: number | null;
  lastTool?: string | null;
  processAlive?: boolean | "unknown";
  idleTimeoutMs?: number | null;
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
  errorCode?: NotificationErrorCode;
}

/** Compatibility name for callers that explicitly request the full result. */
export type JobResult = FullJobResult;

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
