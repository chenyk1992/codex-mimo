import path from "node:path";
import {
  redactDiagnosticText,
  summarizeJobOutput
} from "./job-output.js";
import type {
  CompactJobResult,
  CompactJobStatus,
  ContextOverheadMetrics,
  FullJobResult,
  JobNotificationStatus,
  JobRecord,
  JobResult,
  JobStatusResult,
  JobVerification,
  StandardJobResult
} from "./jobs.js";
import { isNotificationErrorCode } from "../notify/types.js";
import { publicProgressSummary } from "./public-summary.js";
import { compactFailureCauses } from "./job-outcome.js";
import { RESUMABLE_FAILURE_CODES } from "./job-checkpoint.js";
import { isChainOrchestratorRoot, readJobChain } from "./job-chain.js";

export const COMPACT_RESULT_MAX_BYTES = 6_000;
const MAX_COMPACT_COMMAND_CHARS = 240;
const MAX_COMPACT_PATH_CHARS = 500;
const MAX_COMPACT_FILES = 40;
const MAX_COMPACT_TESTS = 12;

function elapsedMs(job: JobRecord, nowMs = Date.now()): number | null {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  if (!Number.isFinite(start)) return null;
  const completed = job.status !== "queued" &&
      job.status !== "running" &&
      job.completedAt
    ? Date.parse(job.completedAt)
    : Number.NaN;
  const end = Number.isFinite(completed) ? completed : nowMs;
  return Math.max(0, end - start);
}

function idleMsFor(job: JobRecord, nowMs: number): number | null {
  if (job.status !== "running" || !job.lastEventAt) return null;
  const last = Date.parse(job.lastEventAt);
  if (!Number.isFinite(last)) return null;
  return Math.max(0, nowMs - last);
}

export interface RenderJobStatusOptions {
  nowMs?: number;
  progress?: string[];
  notification?: JobNotificationStatus;
  processAlive?: boolean | "unknown";
}

export function renderJobStatus(
  job: JobRecord,
  options: RenderJobStatusOptions = {}
): JobStatusResult {
  const nowMs = options.nowMs ?? Date.now();
  const hasPid = typeof job.pid === "number" && job.pid > 0;
  const processAlive = options.processAlive !== undefined
    ? options.processAlive
    : (job.status === "running" && hasPid ? ("unknown" as const) : undefined);
  return {
    jobId: job.id,
    kind: job.kind,
    parentJobId: job.parentJobId ?? null,
    status: job.status,
    ...(job.phase ? { phase: job.phase } : {}),
    elapsedMs: elapsedMs(job, nowMs),
    sessionId: job.sessionId ?? null,
    summary: publicProgressSummary({
      type: "job",
      status: job.status,
      phase: job.phase,
      ...(job.errorCode !== undefined ? { errorCode: job.errorCode } : {})
    }),
    changedFiles: [...job.changedFiles],
    ...(job.cancellationRequestedAt ? { cancellationRequested: true as const } : {}),
    ...(job.executionCallback ? { executionCallback: publicExecutionCallback(job) } : {}),
    progress: (options.progress ?? []).map(() => publicProgressSummary({
      type: "job",
      status: job.status,
      phase: job.phase,
      ...(job.errorCode !== undefined ? { errorCode: job.errorCode } : {})
    })),
    ...(options.notification ? { notification: publicNotification(options.notification) } : {}),
    lastEventAt: job.lastEventAt ?? null,
    idleMs: idleMsFor(job, nowMs),
    lastTool: job.lastTool ?? null,
    ...(processAlive !== undefined ? { processAlive } : {}),
    idleTimeoutMs: job.idleTimeoutMs ?? null,
    actions: statusActions(job.status, job)
  };
}

export function renderCompactJobStatus(job: JobRecord): CompactJobStatus {
  const resultAvailable = job.status !== "queued" && job.status !== "running";
  return {
    status: job.status,
    ...(resultAvailable ? { resultAvailable: true as const } : {}),
    ...(job.assessment !== undefined ? { assessment: job.assessment } : {})
  };
}

export interface RenderCompactJobResultOptions {
  output?: string;
  contextOverhead?: ContextOverheadMetrics;
  measureCompactBytes?: boolean;
}

export function renderCompactJobResult(
  job: JobRecord,
  options: RenderCompactJobResultOptions = {}
): CompactJobResult {
  const publicSummary = publicProgressSummary({
    type: "job",
    status: job.status,
    phase: job.phase,
    ...(job.errorCode ? { errorCode: job.errorCode } : {})
  });
  const tests = compactAcceptanceTests(job);
  const failedVerification = job.verification.find((result) => !result.passed);
  const failure = job.status === "failed" || job.status === "cancelled" || job.status === "timeout" || job.status === "stalled"
    ? {
        code: job.errorCode ?? job.status,
        reason: publicSummary,
        ...compactFailureDetails(job, failedVerification)
      }
    : null;
  const semantic = isSemanticResultJob(job)
    ? summarizeJobOutput(options.output)
    : undefined;
  const attention = buildCompactAttention(job, publicSummary);
  const reportJobId = chainReportJobId(job);
  const result: CompactJobResult = {
    status: job.status,
    changedFiles: job.changedFiles.map(compactFilePath),
    tests,
    failure,
    reportPath: compactReportPath(job, semantic
      ? (job.reportPaths?.plan ?? job.reportPaths?.result ?? job.reportPaths?.markdown)
      : (job.reportPaths?.markdown ?? job.reportPaths?.result)),
    ...(reportJobId ? { reportJobId } : {}),
    ...(semantic ? { summary: semantic } : {}),
    ...(attention ? { attention } : {}),
    ...(job.reconciliation
      ? { reconciliation: publicReconciliation(job.reconciliation) }
      : {}),
    ...(job.assessment !== undefined ? { assessment: job.assessment } : {}),
    ...(options.contextOverhead
      ? {
          contextOverhead: {
            ...options.contextOverhead,
            ...(options.measureCompactBytes ? { compactResultBytes: 999_999 } : {})
          }
        }
      : {})
  };
  const compact = fitCompactResult(result);
  if (options.measureCompactBytes && compact.contextOverhead) {
    settleCompactResultBytes(compact);
  }
  return compact;
}

function chainReportJobId(job: JobRecord): string | undefined {
  if (!isChainOrchestratorRoot(job)) return undefined;
  const report = job.reportPaths?.markdown ??
    job.reportPaths?.json ??
    job.reportPaths?.result;
  if (!report) return undefined;
  const name = path.basename(report)
    .replace(/\.result\.md$/i, "")
    .replace(/\.(?:md|json)$/i, "");
  return name && name !== job.id ? name : undefined;
}

function publicReconciliation(
  reconciliation: NonNullable<JobRecord["reconciliation"]>
): NonNullable<CompactJobResult["reconciliation"]> {
  return {
    status: reconciliation.status,
    changeDetection: {
      status: reconciliation.changeDetection.status,
      sources: [...reconciliation.changeDetection.sources],
      candidates: reconciliation.changeDetection.candidates
        .slice(0, MAX_COMPACT_FILES)
        .map(compactFilePath),
      ...(reconciliation.changeDetection.reason
        ? { reason: reconciliation.changeDetection.reason }
        : {})
    },
    ...(reconciliation.warnings
      ? { warnings: reconciliation.warnings.map((warning) => ({ ...warning })) }
      : {})
  };
}

export function isSemanticResultJob(job: JobRecord): boolean {
  if (job.kind === "plan" || job.kind === "review") return true;
  if (job.kind !== "compose" || typeof job.request !== "object" || job.request === null) {
    return false;
  }
  const workflow = (job.request as Record<string, unknown>).workflow;
  return workflow === "brainstorm" || workflow === "plan" || workflow === "review";
}

export interface RenderJobResultOptions {
  notification?: JobNotificationStatus;
  output?: string;
  keyError?: string;
  contextOverhead?: ContextOverheadMetrics;
}

export function renderJobResult(
  job: JobRecord,
  options: RenderJobResultOptions = {}
): StandardJobResult {
  const partial = job.status === "needs_input" ||
    job.status === "blocked" ||
    job.status === "stalled" ||
    job.status === "timeout" ||
    isResumableFailure(job);
  const compact = renderCompactJobResult(job, {
    output: options.output,
    contextOverhead: options.contextOverhead
  });
  const keyError = options.keyError ?? compact.failure?.failedCommand;
  const sliceCounts = renderSliceCounts(job);
  return {
    ...compact,
    changedFiles: [...job.changedFiles],
    tests: compactAcceptanceTests(job).map((test) => ({
      ...test,
      command: compactLine(redactDiagnosticText(test.command))
    })),
    jobId: job.id,
    kind: job.kind,
    parentJobId: job.parentJobId ?? null,
    resultType: partial ? "partial" : "final",
    summary: compact.summary ?? publicProgressSummary({
      type: "job",
      status: job.status,
      phase: job.phase,
      ...(job.errorCode ? { errorCode: job.errorCode } : {})
    }),
    ...(job.phase ? { phase: job.phase } : {}),
    elapsedMs: elapsedMs(job),
    sessionId: job.sessionId ?? null,
    ...(keyError ? { keyError } : {}),
    ...sliceCounts,
    verification: job.verification.map(compactVerification),
    ...(job.executionCallback ? { executionCallback: publicExecutionCallback(job) } : {}),
    ...(job.error
      ? {
          error: publicProgressSummary({
            type: "job",
            status: job.status,
            ...(job.errorCode ? { errorCode: job.errorCode } : {})
          })
        }
      : {}),
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    ...(job.failureCauses && job.failureCauses.length > 0
      ? { failureCauses: [...job.failureCauses] }
      : {}),
    ...(job.reportPaths ? { reportPaths: { ...job.reportPaths } } : {}),
    ...(options.notification
      ? { notification: publicNotification(options.notification) }
      : {}),
    actions: {
      status: "mimo_status",
      events: "mimo_events",
      ...(partial ? { resume: "mimo_resume" as const } : {})
    }
  };
}

export interface RenderFullJobResultOptions extends RenderJobResultOptions {
  plan?: string;
  verificationDetails?: FullJobResult["verificationDetails"];
  jobLog?: string;
  diff?: string;
  artifactErrors?: FullJobResult["artifactErrors"];
}

export function renderFullJobResult(
  job: JobRecord,
  options: RenderFullJobResultOptions = {}
): JobResult {
  return {
    ...renderJobResult(job, options),
    ...(options.output?.trim() ? { output: options.output } : {}),
    ...(options.plan?.trim() ? { plan: options.plan } : {}),
    ...(options.verificationDetails
      ? { verificationDetails: options.verificationDetails.map((result) => ({ ...result })) }
      : {}),
    ...(options.jobLog?.trim() ? { jobLog: options.jobLog } : {}),
    ...(options.diff?.trim() ? { diff: options.diff } : {}),
    ...(options.artifactErrors
      ? { artifactErrors: options.artifactErrors.map((error) => ({ ...error })) }
      : {})
  };
}

function compactLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_COMPACT_COMMAND_CHARS);
}

function compactFilePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.length <= MAX_COMPACT_PATH_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_COMPACT_PATH_CHARS - 1)}…`;
}

function compactReportPath(job: JobRecord, value: string | undefined): string | null {
  if (!value) return null;
  if (!path.isAbsolute(value)) return value.split(path.sep).join("/");
  const relative = path.relative(job.cwd, value);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : value;
}

function fitCompactResult(input: CompactJobResult): CompactJobResult {
  const result: CompactJobResult = {
    ...input,
    changedFiles: [...input.changedFiles],
    tests: [...input.tests],
    ...(input.failure ? { failure: { ...input.failure } } : {})
  };
  if (compactBytes(result) <= COMPACT_RESULT_MAX_BYTES) return result;

  delete result.summary;
  result.tests = result.tests.slice(0, MAX_COMPACT_TESTS);
  result.changedFiles = compactFiles(result.changedFiles, MAX_COMPACT_FILES);
  if (compactBytes(result) <= COMPACT_RESULT_MAX_BYTES) return result;

  result.tests = firstResultPerStage(result.tests);
  result.changedFiles = compactFiles(input.changedFiles, 10);
  if (result.failure?.failedTests) result.failure.failedTests = result.failure.failedTests.slice(0, 3);
  if (compactBytes(result) <= COMPACT_RESULT_MAX_BYTES) return result;

  result.changedFiles = compactFiles(input.changedFiles, 1);
  result.tests = result.tests.slice(0, 1);
  if (result.failure) {
    result.failure.reason = result.failure.reason.slice(0, 240);
    if (result.failure.suggestion) {
      result.failure.suggestion = result.failure.suggestion.slice(0, 240);
    }
  }
  if (compactBytes(result) > COMPACT_RESULT_MAX_BYTES) {
    throw new Error("Compact job result exceeds the 6000-byte public contract.");
  }
  return result;
}

function compactFiles(files: string[], limit: number): string[] {
  if (files.length <= limit) return files;
  return [
    ...files.slice(0, limit),
    `<${files.length - limit} more; see report>`
  ];
}

function firstResultPerStage(
  tests: CompactJobResult["tests"]
): CompactJobResult["tests"] {
  const seen = new Set<string>();
  return tests.filter((test) => {
    if (seen.has(test.stage)) return false;
    seen.add(test.stage);
    return true;
  });
}

function compactBytes(result: CompactJobResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

function settleCompactResultBytes(result: CompactJobResult): void {
  if (!result.contextOverhead) return;
  let bytes = compactBytes(result);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    result.contextOverhead.compactResultBytes = bytes;
    const next = compactBytes(result);
    if (next === bytes) return;
    bytes = next;
  }
  result.contextOverhead.compactResultBytes = bytes;
}

function publicExecutionCallback(job: JobRecord): NonNullable<JobRecord["executionCallback"]> {
  const callback = job.executionCallback!;
  return {
    invocationId: callback.invocationId,
    outcome: callback.outcome,
    ...(callback.sessionId !== undefined ? { sessionId: callback.sessionId } : {}),
    ...(callback.receivedAt !== undefined ? { receivedAt: callback.receivedAt } : {}),
    ...(callback.error !== undefined
      ? { error: publicProgressSummary({ type: "callback", outcome: callback.outcome }) }
      : {})
  };
}

function publicNotification(notification: JobNotificationStatus): JobNotificationStatus {
  return {
    targetType: notification.targetType,
    status: notification.status,
    attempts: notification.attempts,
    ...(notification.lastError !== undefined
      ? { lastError: publicProgressSummary({ type: "notification" }) }
      : {}),
    ...(notification.errorCode !== undefined && isNotificationErrorCode(notification.errorCode)
      ? { errorCode: notification.errorCode }
      : {})
  };
}

function statusActions(status: JobRecord["status"], job?: JobRecord): JobStatusResult["actions"] {
  if (status === "queued" || status === "running") {
    return {
      events: "mimo_events",
      wait: "mimo_wait",
      cancel: "mimo_cancel"
    };
  }
  if (
    status === "needs_input" ||
    status === "blocked" ||
    status === "stalled" ||
    status === "timeout" ||
    (job && isResumableFailure(job))
  ) {
    return {
      result: "mimo_result",
      events: "mimo_events",
      resume: "mimo_resume"
    };
  }
  return { result: "mimo_result", events: "mimo_events" };
}

function isResumableFailure(job: JobRecord): boolean {
  return job.status === "failed" &&
    job.errorCode !== undefined &&
    RESUMABLE_FAILURE_CODES.has(job.errorCode);
}

function renderSliceCounts(job: JobRecord): {
  completedSlices?: number;
  remainingSlices?: number;
} {
  if (!isChainOrchestratorRoot(job) || !job.chainId) return {};
  const chain = readJobChain(job.cwd, job.chainId);
  if (!chain) return {};
  const total = Object.keys(chain.sliceStates).length;
  const completedSlices = chain.completedSliceIds.length;
  return {
    completedSlices,
    remainingSlices: Math.max(0, total - completedSlices)
  };
}

function buildCompactAttention(
  job: JobRecord,
  publicSummary: string
): CompactJobResult["attention"] {
  if (
    job.status === "needs_input" ||
    job.status === "blocked" ||
    job.status === "stalled" ||
    job.status === "timeout"
  ) {
    return {
      kind: job.status,
      reason: publicSummary,
      ...(job.lastCommand ? { lastCommand: compactLine(redactDiagnosticText(job.lastCommand)) } : {}),
      resume: { tool: "mimo_resume", jobId: job.id }
    };
  }
  if (isResumableFailure(job)) {
    return {
      kind: "resumable_failure",
      reason: publicSummary,
      ...(job.lastCommand ? { lastCommand: compactLine(redactDiagnosticText(job.lastCommand)) } : {}),
      resume: { tool: "mimo_resume", jobId: job.id }
    };
  }
  return undefined;
}

function compactVerification(result: JobVerification): JobVerification {
  return {
    command: compactLine(redactDiagnosticText(result.command)),
    exitCode: result.exitCode,
    passed: result.passed,
    ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    ...(result.source ? { source: result.source } : {})
  };
}

function compactAcceptanceTests(job: JobRecord): CompactJobResult["tests"] {
  if (job.acceptance?.stages && job.acceptance.stages.length > 0) {
    return job.acceptance.stages
      .filter((stage) => stage.outcome !== "pending")
      .map((stage) => ({
        stage: stage.stage,
        command: compactLine(redactDiagnosticText(stage.command ?? "")),
        outcome: stage.outcome === "pending" ? "passed" as const : stage.outcome
      }));
  }
  return job.verification.map((verification) => ({
    stage: "test" as const,
    command: compactLine(redactDiagnosticText(verification.command)),
    outcome: verification.passed ? "passed" as const : "failed" as const
  }));
}

function compactFailureDetails(
  job: JobRecord,
  failedVerification: JobVerification | undefined
): Partial<NonNullable<CompactJobResult["failure"]>> {
  const failedStage = job.acceptance?.failedStage ??
    failedStageFromErrorCode(job.errorCode) ??
    (failedVerification ? "test" as const : undefined);
  const failedCommand = job.acceptance?.failedCommand ??
    (failedVerification
      ? compactLine(redactDiagnosticText(failedVerification.command))
      : undefined);
  return {
    ...(failedStage ? { failedStage } : {}),
    ...(failedCommand ? { failedCommand } : {}),
    ...(job.acceptance?.failedTests && job.acceptance.failedTests.length > 0
      ? { failedTests: [...job.acceptance.failedTests] }
      : {}),
    ...(job.acceptance?.suggestion
      ? { suggestion: compactLine(job.acceptance.suggestion) }
      : {}),
    ...(compactFailureCauses(job.failureCauses)
      ? { causes: compactFailureCauses(job.failureCauses) }
      : {})
  };
}

function failedStageFromErrorCode(
  errorCode: string | undefined
): CompactJobResult["tests"][number]["stage"] | undefined {
  if (errorCode === "build_failed") return "build";
  if (errorCode === "tests_failed") return "test";
  if (
    errorCode === "diff_check_failed" ||
    errorCode === "delivery_contract_missing" ||
    errorCode === "write_scope_violation"
  ) {
    return "diff_check";
  }
  return undefined;
}
