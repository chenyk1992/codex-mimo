import type {
  ExecutionCallbackSummary,
  JobReportPaths,
  JobStatus,
  JobVerification
} from "./jobs.js";

export interface RunEvidence {
  exitCode: number;
  terminationReason?: "process_timeout" | "host_abort" | "user_cancelled";
  executionCallback?: ExecutionCallbackSummary;
  verification: JobVerification[];
  finalText: string;
}

export interface JobOutcome {
  status: Exclude<JobStatus, "queued" | "running">;
  summary: string;
  sessionId?: string | null;
  changedFiles?: string[];
  verification?: JobVerification[];
  executionCallback?: ExecutionCallbackSummary;
  reportPaths?: JobReportPaths;
  error?: string;
  errorCode?: string;
}

const NEEDS_INPUT_PATTERNS = [
  /^(?:i|we)\s+need\s+(?:(?:your|user|additional|more|required|some)\s+)*(?:input|information|details|clarification)\b[\s\S]*$/i,
  /^need(?:ed)?\s+(?:(?:your|user|additional|more|required|some)\s+)*(?:input|information|details|clarification)\s*:[\s\S]*$/i,
  /^please\s+(?:provide|clarify|confirm|specify|share|choose|tell\s+me)\b[\s\S]*$/i,
  /^(?:could|can|would|will)\s+you\s+(?:please\s+)?(?:provide|clarify|confirm|specify|share|choose|tell\s+me)\b[\s\S]*\?$/i,
  /^(?:which|what)\b[\s\S]*\bshould\s+(?:i|we)\b[\s\S]*\?$/i,
  /^should\s+(?:i|we)\b[\s\S]*\?$/i
] as const;

const BLOCKED_PATTERNS = [
  /^(?:(?:i\s+am|we\s+are)\s+)?blocked\b[\s\S]*$/i,
  /^(?:i|we)\s+(?:cannot|can't|am\s+unable\s+to|are\s+unable\s+to)\s+(?:continue|proceed)\b[\s\S]*$/i,
  /^(?:cannot|can't|unable\s+to)\s+(?:continue|proceed)\b[\s\S]*$/i,
  /^missing\s+(?:a\s+|an\s+|the\s+)?(?:required\s+)?(?:permission|dependency|external\s+service)\b[\s\S]*$/i,
  /^(?:required\s+)?(?:permission|dependency|external\s+service)\s+(?:is\s+)?(?:missing|unavailable|required)\b[\s\S]*$/i
] as const;

export function classifyRunOutcome(evidence: RunEvidence): JobOutcome {
  const summary = evidence.finalText.trim();
  const common = commonOutcomeFields(evidence);

  if (evidence.terminationReason === "user_cancelled") {
    return failureOutcome("cancelled", summary || "Job cancelled by user.", "cancelled", common);
  }
  if (
    evidence.terminationReason === "process_timeout" ||
    (evidence.terminationReason === undefined && evidence.exitCode === 124)
  ) {
    return failureOutcome("timeout", summary || "Job timed out.", "timeout", common);
  }

  const callbackCode = callbackFailureCode(evidence.executionCallback);
  if (callbackCode) {
    const callbackError = evidence.executionCallback?.error
      ?? `MiMoCode completion callback reported ${evidence.executionCallback?.outcome}.`;
    return {
      status: "failed",
      summary: summary || callbackError,
      ...common,
      error: callbackError,
      errorCode: callbackCode
    };
  }

  if (matchesExplicitOutput(summary, NEEDS_INPUT_PATTERNS)) {
    return { status: "needs_input", summary, ...common };
  }
  if (matchesExplicitOutput(summary, BLOCKED_PATTERNS)) {
    return { status: "blocked", summary, ...common };
  }

  if (evidence.verification.some((result) => !result.passed)) {
    return failureOutcome(
      "failed",
      summary || "Verification failed.",
      "verification_failed",
      common,
      "One or more verification commands failed."
    );
  }
  if (evidence.exitCode !== 0 || evidence.terminationReason === "host_abort") {
    const error = evidence.terminationReason === "host_abort"
      ? "MiMoCode run was aborted by the host."
      : `MiMoCode exited with code ${evidence.exitCode}.`;
    return failureOutcome("failed", summary || error, "mimo_exit_nonzero", common, error);
  }

  return {
    status: "completed",
    summary: summary || "Job completed.",
    ...common
  };
}

function commonOutcomeFields(evidence: RunEvidence): Pick<
  JobOutcome,
  "sessionId" | "verification" | "executionCallback"
> {
  return {
    ...(evidence.executionCallback?.sessionId !== undefined
      ? { sessionId: evidence.executionCallback.sessionId }
      : {}),
    verification: evidence.verification,
    ...(evidence.executionCallback ? { executionCallback: evidence.executionCallback } : {})
  };
}

function failureOutcome(
  status: "failed" | "cancelled" | "timeout",
  summary: string,
  errorCode: string,
  common: Pick<JobOutcome, "sessionId" | "verification" | "executionCallback">,
  error = summary
): JobOutcome {
  return { status, summary, ...common, error, errorCode };
}

function callbackFailureCode(callback?: ExecutionCallbackSummary): string | undefined {
  if (callback?.outcome === "missing") return "callback_missing";
  if (callback?.outcome === "error") return "callback_error";
  if (callback?.outcome === "cancelled") return "callback_cancelled";
  return undefined;
}

function matchesExplicitOutput(text: string, patterns: readonly RegExp[]): boolean {
  if (!text) return false;
  const paragraphs = text
    .split(/\r?\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return paragraphs.some((part) => patterns.some((pattern) => pattern.test(part)));
}
