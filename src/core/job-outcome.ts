import type {
  ArtifactAssessment,
  ExecutionCallbackSummary,
  JobAcceptanceSummary,
  JobReconciliationSummary,
  JobReportPaths,
  JobStatus,
  JobVerification
} from "./jobs.js";
import type { JobFailureCause } from "./safety-contracts.js";
import { COMPACT_FAILURE_CAUSE_LIMIT } from "./safety-contracts.js";
import { publicProgressSummary } from "./public-summary.js";

export interface RunEvidence {
  exitCode: number;
  terminationReason?:
    | "process_timeout"
    | "idle_timeout"
    | "progress_timeout"
    | "host_abort"
    | "user_cancelled";
  stallErrorCode?: string;
  /** Authoritative JSONL primary session; preferred over callback session. */
  runSessionId?: string;
  executionCallback?: ExecutionCallbackSummary;
  verification: JobVerification[];
  finalText: string;
  requireFinalText?: boolean;
  /** Optional secondary failure causes aggregated after primary classification. */
  failureCauses?: JobFailureCause[];
  /** Explicit session drift observed in JSONL (do not overwrite runSessionId). */
  eventSessionMismatch?: boolean;
}

export interface JobOutcome {
  status: Exclude<JobStatus, "queued" | "running">;
  summary: string;
  sessionId?: string | null;
  changedFiles?: string[];
  verification?: JobVerification[];
  acceptance?: JobAcceptanceSummary;
  executionCallback?: ExecutionCallbackSummary;
  reportPaths?: JobReportPaths;
  error?: string;
  errorCode?: string;
  causes?: JobFailureCause[];
  /** Compose-specific deliverable assessment derived from the report status. */
  assessment?: ArtifactAssessment;
  reconciliation?: JobReconciliationSummary;
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

const UNACCEPTED_TASK_PATTERNS = [
  /^how (?:can|may) i (?:help|assist)(?: you)?[?!.\s]*$/i,
  /^what (?:task|objective|goal|problem)\b[\s\S]{0,120}[?!.\s]*$/i,
  /^what (?:can i help|would you like)(?: me)?[\s\S]{0,120}[?!.\s]*$/i,
  /^please share (?:your|the) (?:task|objective|goal)[?!.\s]*$/i,
  /^(?:i )?(?:do not|don't|cannot|can't) (?:see|find|have).*(?:task|objective|goal)[\s\S]{0,200}$/i,
  /^(?:no|missing|without)\s+(?:an?\s+|the\s+|actual\s+|specific\s+|concrete\s+)*(?:task|objective|description|goal)\b[\s\S]*$/i,
  /^(?:the )?(?:task|objective) is empty[?!.\s]*$/i,
  /^it looks like (?:your )?message got cut off[\s\S]*$/i,
  /^it looks like .*objective is empty[\s\S]*$/i,
  /^[\s\S]*(?:have not|haven't|did not|didn't) (?:provide|receive|see)[\s\S]*(?:task|objective|goal)[\s\S]*$/i,
  /^ready\.\s*what do you need[?!.\s]*$/i,
  /^how (?:can|may) i help[?!.\s]+what task or problem[\s\S]*$/i,
  /^the skill [\s\S]+ is not available\.[\s\S]*what are you trying to accomplish[?!.\s]*$/i,
  /^[\s\S]*don't see (?:the )?(?:actual )?task description[\s\S]*$/i,
  /^what task would you like me to plan\?[\s\S]*objective field appears to be empty[?!.\s]*$/i,
  /^(?:您好|你好)[，,！!\s]*(?:有什么.*(?:帮|协助).*|请问.*)[?？!！。\s]*$/i,
  /^[\s\S]*(?:消息.*空|尚未提供具体的?任务描述|没有提供具体的?任务目标)[\s\S]*$/i,
  /^(?:想要我帮您规划什么|想要完成什么)[?？!！。\s]*$/i
] as const;

const UNACCEPTED_TASK_ERROR = "MiMoCode did not receive or accept the task objective.";

export function classifyRunOutcome(evidence: RunEvidence): JobOutcome {
  const context: OutcomeClassificationContext = {
    evidence,
    finalText: evidence.finalText.trim(),
    common: commonOutcomeFields(evidence),
    suppliedCauses: evidence.failureCauses ?? []
  };
  return classifyCancellation(context)
    ?? classifyPromptIdentityFailure(context)
    ?? classifySessionIdentityFailure(context)
    ?? classifyTermination(context)
    ?? classifyCallbackFailure(context)
    ?? classifyReportedStatus(context)
    ?? classifyExecutionFailure(context)
    ?? withCauses({
      status: "completed",
      summary: "MiMoCode completed the job.",
      ...context.common
    }, context.suppliedCauses);
}

interface OutcomeClassificationContext {
  evidence: RunEvidence;
  finalText: string;
  common: Pick<JobOutcome, "sessionId" | "verification" | "executionCallback">;
  suppliedCauses: JobFailureCause[];
}

function classifyCancellation(context: OutcomeClassificationContext): JobOutcome | undefined {
  if (context.evidence.terminationReason !== "user_cancelled") return undefined;
  return withCauses(
    failureOutcome("cancelled", "MiMoCode job was cancelled.", "cancelled", context.common),
    context.suppliedCauses,
    { code: "cancelled", stage: "execution" }
  );
}

function classifyPromptIdentityFailure(
  context: OutcomeClassificationContext
): JobOutcome | undefined {
  if (!hasCause(context.suppliedCauses, "prompt_identity_mismatch")) return undefined;
  return withCauses(
    failureOutcome(
      "failed",
      "MiMoCode prompt identity did not match the job query.",
      "prompt_identity_mismatch",
      context.common,
      "MiMoCode prompt identity did not match the job query."
    ),
    context.suppliedCauses,
    { code: "prompt_identity_mismatch", stage: "prompt" }
  );
}

function classifySessionIdentityFailure(
  context: OutcomeClassificationContext
): JobOutcome | undefined {
  const { evidence, common, suppliedCauses } = context;
  if (evidence.eventSessionMismatch || hasCause(suppliedCauses, "event_session_mismatch")) {
    return withCauses(
      failureOutcome(
        "failed",
        "MiMoCode JSONL session identity changed during the run.",
        "event_session_mismatch",
        common
      ),
      suppliedCauses,
      { code: "event_session_mismatch", stage: "execution" }
    );
  }
  if (!hasCallbackSessionMismatch(evidence)) return undefined;
  return withCauses(
    failureOutcome(
      "failed",
      "MiMoCode completion callback session did not match the run session.",
      "callback_session_mismatch",
      common
    ),
    suppliedCauses,
    { code: "callback_session_mismatch", stage: "callback" }
  );
}

function classifyTermination(context: OutcomeClassificationContext): JobOutcome | undefined {
  const { evidence, common, suppliedCauses } = context;
  if (evidence.terminationReason === "progress_timeout") {
    const errorCode = evidence.stallErrorCode ?? "no_effective_progress";
    const summary = publicProgressSummary({ type: "job", status: "stalled", errorCode });
    return withCauses(
      { status: "stalled", summary, errorCode, error: summary, ...common },
      suppliedCauses,
      { code: errorCode, stage: "execution" }
    );
  }
  if (evidence.terminationReason === "idle_timeout") {
    return withCauses(
      failureOutcome("timeout", "MiMoCode job idle-timed out.", "idle_timeout", common),
      suppliedCauses,
      { code: "idle_timeout", stage: "execution" }
    );
  }
  const processTimedOut = evidence.terminationReason === "process_timeout" ||
    (evidence.terminationReason === undefined && evidence.exitCode === 124);
  if (!processTimedOut) return undefined;
  return withCauses(
    failureOutcome("timeout", "MiMoCode job timed out.", "timeout", common),
    suppliedCauses,
    { code: "process_timeout", stage: "execution" }
  );
}

function classifyCallbackFailure(context: OutcomeClassificationContext): JobOutcome | undefined {
  const callbackCode = callbackFailureCode(context.evidence.executionCallback);
  if (!callbackCode) return undefined;
  const callbackError = callbackCode === "callback_missing"
    ? "MiMoCode completion callback was not received."
    : callbackCode === "callback_cancelled"
      ? "MiMoCode completion callback reported cancellation."
      : "MiMoCode completion callback reported an error.";
  return withCauses(
    {
      status: "failed",
      summary: "MiMoCode completion callback was not accepted.",
      ...context.common,
      error: callbackError,
      errorCode: callbackCode
    },
    context.suppliedCauses,
    { code: callbackCode, stage: "callback" }
  );
}

function classifyReportedStatus(context: OutcomeClassificationContext): JobOutcome | undefined {
  const { finalText, common, suppliedCauses } = context;
  const semanticFailure = detectUnacceptedTask(finalText);
  if (semanticFailure) {
    return withCauses(
      failureOutcome("failed", semanticFailure, "semantic_failure", common, semanticFailure),
      suppliedCauses,
      { code: "semantic_failure", stage: "execution" }
    );
  }
  if (matchesExplicitOutput(finalText, NEEDS_INPUT_PATTERNS)) {
    return withCauses(
      { status: "needs_input", summary: "MiMoCode needs additional input.", ...common },
      suppliedCauses
    );
  }
  if (!matchesExplicitOutput(finalText, BLOCKED_PATTERNS)) return undefined;
  return withCauses(
    { status: "blocked", summary: "MiMoCode is blocked by an external condition.", ...common },
    suppliedCauses
  );
}

function classifyExecutionFailure(
  context: OutcomeClassificationContext
): JobOutcome | undefined {
  const { evidence, finalText, common, suppliedCauses } = context;
  if (evidence.verification.some((result) => !result.passed)) {
    return withCauses(
      failureOutcome(
        "failed",
        "MiMoCode verification failed.",
        "verification_failed",
        common,
        "One or more verification commands failed."
      ),
      suppliedCauses,
      { code: "verification_failed", stage: "test" }
    );
  }
  if (evidence.exitCode !== 0 || evidence.terminationReason === "host_abort") {
    const error = evidence.terminationReason === "host_abort"
      ? "MiMoCode run was aborted by the host."
      : `MiMoCode exited with code ${evidence.exitCode}.`;
    return withCauses(
      failureOutcome("failed", "MiMoCode execution failed.", "mimo_exit_nonzero", common, error),
      suppliedCauses,
      { code: "mimo_exit_nonzero", stage: "execution" }
    );
  }
  if (!evidence.requireFinalText || finalText) return undefined;
  return withCauses(
    failureOutcome(
      "failed",
      "MiMoCode did not return a final result.",
      "result_missing",
      common,
      "MiMoCode did not return a final result."
    ),
    suppliedCauses,
    { code: "result_missing", stage: "execution" }
  );
}

export function detectUnacceptedTask(finalText: string | undefined): string | undefined {
  const text = finalText?.trim();
  if (!text || text.length > 500 || text.includes("```")) return undefined;
  const normalized = normalizeGreetingPrefix(text);
  return UNACCEPTED_TASK_PATTERNS.some((pattern) => pattern.test(normalized))
    ? UNACCEPTED_TASK_ERROR
    : undefined;
}

export function compactFailureCauses(causes: JobFailureCause[] | undefined): JobFailureCause[] | undefined {
  if (!causes || causes.length === 0) return undefined;
  const hasSpecificVerificationCause = causes.some((cause) =>
    cause.code === "build_failed" ||
    cause.code === "tests_failed" ||
    cause.code === "diff_check_failed"
  );
  const unique = new Map<string, JobFailureCause>();
  for (const cause of causes) {
    if (cause.code === "verification_failed" && hasSpecificVerificationCause) {
      continue;
    }
    if (
      cause.code === "write_scope_violation" &&
      cause.suggestion?.trim().toLowerCase() === "blocked path: unknown"
    ) {
      continue;
    }
    const key = JSON.stringify([
      cause.code,
      cause.stage,
      cause.command ?? "",
      cause.suggestion ?? ""
    ]);
    if (!unique.has(key)) unique.set(key, cause);
  }
  const compact = [...unique.values()].slice(0, COMPACT_FAILURE_CAUSE_LIMIT);
  return compact.length > 0 ? compact : undefined;
}

function normalizeGreetingPrefix(text: string): string {
  return text.replace(/^(?:hello|hi|hey)\b(?:[!.,]+\s*|\s+)/i, "").trim();
}

function commonOutcomeFields(evidence: RunEvidence): Pick<
  JobOutcome,
  "sessionId" | "verification" | "executionCallback"
> {
  const sessionId = evidence.runSessionId !== undefined
    ? evidence.runSessionId
    : evidence.executionCallback?.sessionId;
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    verification: evidence.verification,
    ...(evidence.executionCallback
      ? { executionCallback: toPublicExecutionCallback(evidence.executionCallback) }
      : {})
  };
}

function toPublicExecutionCallback(callback: ExecutionCallbackSummary): ExecutionCallbackSummary {
  return {
    invocationId: callback.invocationId,
    outcome: callback.outcome,
    ...(callback.sessionId !== undefined ? { sessionId: callback.sessionId } : {}),
    ...(callback.receivedAt !== undefined ? { receivedAt: callback.receivedAt } : {}),
    ...(callback.outcome === "missing"
      ? { error: "MiMoCode completion callback was not received." }
      : callback.outcome === "error"
        ? { error: "MiMoCode completion callback reported an error." }
        : callback.outcome === "cancelled"
          ? { error: "MiMoCode completion callback reported cancellation." }
          : {})
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
  if (!callback || callback.outcome === "missing") return "callback_missing";
  if (callback?.outcome === "error") return "callback_error";
  if (callback?.outcome === "cancelled") return "callback_cancelled";
  return undefined;
}

function hasCallbackSessionMismatch(evidence: RunEvidence): boolean {
  const runSessionId = evidence.runSessionId;
  const callbackSessionId = evidence.executionCallback?.sessionId;
  return (
    typeof runSessionId === "string" &&
    runSessionId.length > 0 &&
    typeof callbackSessionId === "string" &&
    callbackSessionId.length > 0 &&
    runSessionId !== callbackSessionId
  );
}

function hasCause(causes: JobFailureCause[], code: string): boolean {
  return causes.some((cause) => cause.code === code);
}

function withCauses(
  outcome: JobOutcome,
  supplied: JobFailureCause[],
  primary?: JobFailureCause
): JobOutcome {
  if (supplied.length === 0) {
    return outcome;
  }
  const merged: JobFailureCause[] = [];
  const seen = new Set<string>();
  const push = (cause: JobFailureCause | undefined) => {
    if (!cause) return;
    const key = `${cause.code}:${cause.stage}:${cause.command ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(cause);
  };
  push(primary);
  for (const cause of supplied) push(cause);
  if (merged.length === 0) return outcome;
  return { ...outcome, causes: merged };
}

function matchesExplicitOutput(text: string, patterns: readonly RegExp[]): boolean {
  if (!text) return false;
  const paragraphs = text
    .split(/(?:\r?\n){2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const finalParagraph = paragraphs.at(-1);
  if (!finalParagraph) return false;
  const finalSentence = finalParagraph
    .split(/(?<=[.!?])\s+(?=\S)/)
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  return finalSentence !== undefined && patterns.some((pattern) => pattern.test(finalSentence));
}
