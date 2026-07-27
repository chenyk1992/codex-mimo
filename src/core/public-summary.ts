import type { JobPhase, JobStatus } from "./jobs.js";

export const MAX_PUBLIC_SUMMARY_LENGTH = 160;

const KNOWN_OPERATOR_ERROR_SUMMARIES: Readonly<Record<string, string>> = {
  stale_queued: "MiMoCode job stayed queued too long.",
  idle_timeout: "MiMoCode job idle-timed out.",
  no_effective_progress: "MiMoCode job stalled without effective progress.",
  slice_plan_invalid: "MiMoCode slice plan was invalid.",
  slice_failed: "MiMoCode slice chain failed.",
  prompt_identity_mismatch: "MiMoCode prompt identity did not match the job query.",
  callback_session_mismatch: "MiMoCode completion callback session did not match the run session.",
  event_session_mismatch: "MiMoCode JSONL session identity changed during the run.",
  write_scope_violation: "MiMoCode changed files outside the allowed write scope.",
  acceptance_command_unavailable: "MiMoCode acceptance command is unavailable in this workspace."
};

export type PublicSummaryContext =
  | { type: "job"; status: JobStatus; phase?: JobPhase; errorCode?: string }
  | {
      type: "signal";
      kind:
        | "phase_changed"
        | "milestone"
        | "needs_input"
        | "blocked"
        | "stalled"
        | "verification_started"
        | "verification_finished"
        | "completed"
        | "failed"
        | "cancelled"
        | "timeout";
      status?: JobStatus;
      phase?: JobPhase;
      errorCode?: string;
    }
  | {
      type: "event";
      eventType: "message" | "tool" | "diff" | "usage" | "error" | "progress" | "raw";
      progressKind?: "step_start" | "step_finish";
    }
  | { type: "callback"; outcome: "completed" | "error" | "cancelled" | "missing" }
  | { type: "notification" }
  | { type: "diagnostic" };

export function publicProgressSummary(context: PublicSummaryContext): string {
  const summary = summaryFor(context);
  return summary
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PUBLIC_SUMMARY_LENGTH);
}

function summaryFor(context: PublicSummaryContext): string {
  if (context.type === "event") {
    if (context.eventType === "tool") return "MiMoCode ran a tool.";
    if (context.eventType === "diff") return "MiMoCode reported file changes.";
    if (context.eventType === "usage") return "MiMoCode usage updated.";
    if (context.eventType === "error") return "MiMoCode reported an error.";
    if (context.progressKind === "step_start") return "MiMoCode started a step.";
    if (context.progressKind === "step_finish") return "MiMoCode finished a step.";
    if (context.eventType === "raw") return "MiMoCode emitted an unrecognized event.";
    return "MiMoCode reported progress.";
  }

  if (context.type === "signal") {
    if (context.kind === "verification_started") return "Verification started.";
    if (context.kind === "verification_finished") return "Verification finished.";
    if (context.kind === "milestone") return "MiMoCode reported progress.";
    if (context.kind === "phase_changed") return runningSummary(context.phase);
    if (context.kind === "failed") {
      return knownOperatorErrorSummary(context.errorCode) ?? statusSummary("failed");
    }
    if (context.kind === "timeout") {
      return knownOperatorErrorSummary(context.errorCode) ?? statusSummary("timeout");
    }
    if (context.kind === "stalled") {
      return knownOperatorErrorSummary(context.errorCode) ?? statusSummary("stalled");
    }
    return statusSummary(context.kind);
  }

  if (context.type === "job") {
    if (context.status === "running") return runningSummary(context.phase);
    if (context.status === "failed") {
      return knownOperatorErrorSummary(context.errorCode) ?? statusSummary("failed");
    }
    if (context.status === "timeout") {
      return knownOperatorErrorSummary(context.errorCode) ?? statusSummary("timeout");
    }
    if (context.status === "stalled") {
      return knownOperatorErrorSummary(context.errorCode) ?? statusSummary("stalled");
    }
    return statusSummary(context.status);
  }

  if (context.type === "callback") {
    if (context.outcome === "completed") return "MiMoCode completion callback was accepted.";
    if (context.outcome === "missing") return "MiMoCode completion callback was not received.";
    if (context.outcome === "cancelled") return "MiMoCode completion callback reported cancellation.";
    return "MiMoCode completion callback reported an error.";
  }

  if (context.type === "notification") return "Notification delivery requires attention.";
  return "MiMoCode job diagnostic recorded.";
}

function knownOperatorErrorSummary(errorCode?: string): string | undefined {
  if (!errorCode) return undefined;
  return KNOWN_OPERATOR_ERROR_SUMMARIES[errorCode];
}

function runningSummary(phase?: JobPhase): string {
  return phase ? `MiMoCode entered the ${phase} phase.` : "MiMoCode job is running.";
}

function statusSummary(status: JobStatus): string {
  const summaries: Record<JobStatus, string> = {
    queued: "MiMoCode job is queued.",
    running: "MiMoCode job is running.",
    needs_input: "MiMoCode needs additional input.",
    blocked: "MiMoCode is blocked by an external condition.",
    stalled: "MiMoCode job stalled without effective progress.",
    completed: "MiMoCode completed the job.",
    failed: "MiMoCode job failed.",
    cancelled: "MiMoCode job was cancelled.",
    timeout: "MiMoCode job timed out."
  };
  return summaries[status];
}
