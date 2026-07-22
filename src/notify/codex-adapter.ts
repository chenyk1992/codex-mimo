import type { JobSignal } from "../core/job-signals.js";
import type { JobRecord } from "../core/jobs.js";
import {
  CodexAppServerError
} from "./codex-app-server.js";
import type { PreparedCodexConnection } from "./codex-connection.js";
import type {
  DeliveryAttemptResult,
  NotificationDelivery,
  NotificationErrorCode
} from "./types.js";
import { publicProgressSummary } from "../core/public-summary.js";

const MAX_PROMPT_LENGTH = 240;

export function buildCodexNotificationPrompt(
  delivery: NotificationDelivery,
  job: JobRecord,
  signal: JobSignal
): string {
  const base = `MiMoCode notification event ${JSON.stringify(singleLine(delivery.eventId))} ` +
    `emitted ${signal.kind} and may be a retry. ` +
    `Call mimo_result with cwd ${JSON.stringify(singleLine(job.cwd))} ` +
    `and jobId ${JSON.stringify(singleLine(job.id))}; continue handling the original request.`;
  if (signal.kind !== "needs_input" && signal.kind !== "blocked") return base;

  const reasonPrefix = " Reason: ";
  const available = Math.max(0, MAX_PROMPT_LENGTH - base.length - reasonPrefix.length);
  if (available === 0) return base;
  const reason = publicProgressSummary({
    type: "signal",
    kind: signal.kind,
    status: signal.status,
    phase: signal.phase
  }).slice(0, available);
  return `${base}${reasonPrefix}${reason}`;
}

export async function deliverCodexNotification(
  delivery: NotificationDelivery,
  job: JobRecord,
  signal: JobSignal,
  prepared: PreparedCodexConnection,
  attemptSignal?: AbortSignal
): Promise<DeliveryAttemptResult> {
  if (delivery.target.type !== "codex") {
    return { outcome: "permanent", error: "Notification target is not Codex" };
  }

  const client = prepared.client;
  try {
    if (!prepared.probe.ok) return classifyPreparedConnection(prepared.probe.errorCode);
    if (!client || !prepared.thread) {
      return classifyPreparedConnection("codex_app_server_unavailable");
    }
    if (!prepared.thread.exists) {
      return {
        outcome: "permanent",
        error: "Codex thread does not exist",
        errorCode: "codex_thread_missing"
      };
    }
    if (prepared.thread.busy) {
      return {
        outcome: "retry",
        error: "Codex thread is busy",
        errorCode: "codex_thread_busy"
      };
    }
    const completion = await client.startTurnAndWait(
      delivery.target.threadId,
      buildCodexNotificationPrompt(delivery, job, signal),
      attemptSignal
    );
    if (completion.status === "interrupted") {
      return {
        outcome: "retry",
        error: "Codex callback turn was interrupted",
        errorCode: "codex_turn_interrupted"
      };
    }
    if (completion.status === "failed") {
      return {
        outcome: "retry",
        error: "Codex callback turn failed",
        errorCode: "codex_turn_failed"
      };
    }
    return { outcome: "delivered" };
  } catch (error) {
    return classifyCodexError(error);
  } finally {
    try {
      await client?.close();
    } catch {
      // Cleanup is best effort after the delivery outcome has been determined.
    }
  }
}

function classifyPreparedConnection(
  errorCode: NotificationErrorCode | undefined
): DeliveryAttemptResult {
  return classifyCodexError(new CodexAppServerError(
    errorCode ?? "codex_app_server_unavailable",
    "Codex App Server connection is unavailable"
  ));
}

export function classifyCodexError(error: unknown): DeliveryAttemptResult {
  if (!(error instanceof CodexAppServerError)) {
    return {
      outcome: "retry",
      error: "Codex App Server request failed",
      errorCode: "codex_app_server_unavailable"
    };
  }
  const permanent = error.code === "codex_cli_not_found" ||
    error.code === "codex_cli_not_executable" ||
    error.code === "codex_app_server_incompatible" ||
    error.code === "codex_thread_missing" ||
    error.code === "codex_thread_forbidden";
  return {
    outcome: permanent ? "permanent" : "retry",
    error: publicCodexNotificationError(error.code),
    errorCode: error.code
  };
}

function publicCodexNotificationError(code: NotificationErrorCode): string {
  switch (code) {
    case "codex_cli_not_found":
    case "codex_cli_not_executable":
      return "Codex App Server executable is unavailable";
    case "codex_app_server_incompatible":
      return "Codex App Server protocol is incompatible";
    case "codex_thread_missing":
      return "Codex thread does not exist";
    case "codex_thread_forbidden":
      return "Codex thread is forbidden";
    case "codex_thread_busy":
      return "Codex thread is busy";
    case "codex_app_server_unavailable":
      return "Codex App Server request failed";
    case "codex_turn_interrupted":
      return "Codex callback turn was interrupted";
    case "codex_turn_failed":
      return "Codex callback turn failed";
    case "codex_turn_timeout":
      return "Codex callback turn timed out";
  }
}

function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}
