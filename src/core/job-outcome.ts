import type {
  ExecutionCallbackSummary,
  JobReportPaths,
  JobStatus,
  JobVerification
} from "./jobs.js";

export interface RunEvidence {
  exitCode: number;
  terminationReason?: "process_timeout" | "idle_timeout" | "host_abort" | "user_cancelled";
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
  const finalText = evidence.finalText.trim();
  const common = commonOutcomeFields(evidence);

  if (evidence.terminationReason === "user_cancelled") {
    return failureOutcome("cancelled", "MiMoCode job was cancelled.", "cancelled", common);
  }
  if (evidence.terminationReason === "idle_timeout") {
    return failureOutcome(
      "timeout",
      "MiMoCode job idle-timed out.",
      "idle_timeout",
      common
    );
  }
  if (
    evidence.terminationReason === "process_timeout" ||
    (evidence.terminationReason === undefined && evidence.exitCode === 124)
  ) {
    return failureOutcome("timeout", "MiMoCode job timed out.", "timeout", common);
  }

  const callbackCode = callbackFailureCode(evidence.executionCallback);
  if (callbackCode) {
    const callbackError = callbackCode === "callback_missing"
      ? "MiMoCode completion callback was not received."
      : callbackCode === "callback_cancelled"
        ? "MiMoCode completion callback reported cancellation."
        : "MiMoCode completion callback reported an error.";
    return {
      status: "failed",
      summary: "MiMoCode completion callback was not accepted.",
      ...common,
      error: callbackError,
      errorCode: callbackCode
    };
  }

  const semanticFailure = detectUnacceptedTask(finalText);
  if (semanticFailure) {
    return failureOutcome("failed", semanticFailure, "semantic_failure", common, semanticFailure);
  }

  if (matchesExplicitOutput(finalText, NEEDS_INPUT_PATTERNS)) {
    return { status: "needs_input", summary: "MiMoCode needs additional input.", ...common };
  }
  if (matchesExplicitOutput(finalText, BLOCKED_PATTERNS)) {
    return { status: "blocked", summary: "MiMoCode is blocked by an external condition.", ...common };
  }

  if (evidence.verification.some((result) => !result.passed)) {
    return failureOutcome(
      "failed",
      "MiMoCode verification failed.",
      "verification_failed",
      common,
      "One or more verification commands failed."
    );
  }
  if (evidence.exitCode !== 0 || evidence.terminationReason === "host_abort") {
    const error = evidence.terminationReason === "host_abort"
      ? "MiMoCode run was aborted by the host."
      : `MiMoCode exited with code ${evidence.exitCode}.`;
    return failureOutcome("failed", "MiMoCode execution failed.", "mimo_exit_nonzero", common, error);
  }

  return {
    status: "completed",
    summary: "MiMoCode completed the job.",
    ...common
  };
}

export function detectUnacceptedTask(finalText: string | undefined): string | undefined {
  const text = finalText?.trim();
  if (!text || text.length > 500 || text.includes("```")) return undefined;
  const normalized = normalizeGreetingPrefix(text);
  return UNACCEPTED_TASK_PATTERNS.some((pattern) => pattern.test(normalized))
    ? UNACCEPTED_TASK_ERROR
    : undefined;
}

function normalizeGreetingPrefix(text: string): string {
  return text.replace(/^(?:hello|hi|hey)\b(?:[!.,]+\s*|\s+)/i, "").trim();
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
