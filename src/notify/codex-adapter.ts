import type { JobSignal } from "../core/job-signals.js";
import type { JobRecord } from "../core/jobs.js";
import {
  CodexAppServerError,
  type CodexAppServerClient
} from "./codex-app-server.js";
import type { DeliveryAttemptResult, NotificationDelivery } from "./types.js";
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
  client: CodexAppServerClient,
  attemptSignal?: AbortSignal
): Promise<DeliveryAttemptResult> {
  if (delivery.target.type !== "codex") {
    return { outcome: "permanent", error: "Notification target is not Codex" };
  }

  let result: DeliveryAttemptResult;
  try {
    await client.initialize(attemptSignal);
    const thread = await client.resumeThread(delivery.target.threadId, attemptSignal);
    if (!thread.exists) {
      result = { outcome: "permanent", error: "Codex thread does not exist" };
    } else if (thread.busy) {
      result = { outcome: "retry", error: "Codex thread is busy" };
    } else {
      await client.startTurn(
        delivery.target.threadId,
        buildCodexNotificationPrompt(delivery, job, signal),
        attemptSignal
      );
      result = { outcome: "delivered" };
    }
  } catch (error) {
    result = classifyCodexError(error);
  }

  try {
    await client.close();
  } catch {
    // Cleanup is best effort after the delivery outcome has been determined.
  }
  return result;
}

function classifyCodexError(error: unknown): DeliveryAttemptResult {
  return error instanceof CodexAppServerError && error.kind === "forbidden"
    ? { outcome: "permanent", error: "Codex thread is forbidden" }
    : { outcome: "retry", error: "Codex App Server request failed" };
}

function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}
