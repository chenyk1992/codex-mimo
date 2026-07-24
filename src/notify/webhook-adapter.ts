import { createHmac } from "node:crypto";
import type { JobSignal, JobSignalKind } from "../core/job-signals.js";
import type {
  JobKind,
  JobRecord,
  JobReportPaths,
  JobStatus,
  JobVerification
} from "../core/jobs.js";
import type { DeliveryAttemptResult, NotificationDelivery } from "./types.js";
import { publicProgressSummary } from "../core/public-summary.js";

export interface NotificationPayload {
  version: 1;
  eventId: string;
  event: JobSignalKind;
  createdAt: string;
  job: {
    id: string;
    kind: JobKind;
    status: JobStatus;
    summary: string;
  };
  result: {
    changedFiles: string[];
    verification: JobVerification[];
    reportPaths: JobReportPaths;
  };
}

const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

export interface WebhookAttemptOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  cancelTimeout?: (timer: unknown) => void;
}

export function buildNotificationPayload(
  delivery: NotificationDelivery,
  job: JobRecord,
  signal: JobSignal
): NotificationPayload {
  return {
    version: 1,
    eventId: delivery.eventId,
    event: signal.kind,
    createdAt: signal.createdAt,
    job: {
      id: job.id,
      kind: job.kind,
      status: job.status,
      summary: publicProgressSummary({
        type: "job",
        status: job.status,
        phase: job.phase,
        ...(job.errorCode !== undefined ? { errorCode: job.errorCode } : {})
      })
    },
    result: {
      changedFiles: [...job.changedFiles],
      verification: job.verification.map((verification) => ({ ...verification })),
      reportPaths: { ...job.reportPaths }
    }
  };
}

export function signWebhookBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

export async function deliverWebhook(
  delivery: NotificationDelivery,
  job: JobRecord,
  signal: JobSignal,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = globalThis.fetch,
  options: WebhookAttemptOptions = {}
): Promise<DeliveryAttemptResult> {
  if (delivery.target.type !== "webhook") {
    return { outcome: "permanent", error: "Notification target is not a webhook" };
  }

  const secret = env[delivery.target.secretEnv];
  if (secret === undefined || secret.length === 0) {
    return {
      outcome: "permanent",
      error: `Webhook secret environment variable ${delivery.target.secretEnv} is missing or empty`
    };
  }

  const body = JSON.stringify(buildNotificationPayload(delivery, job, signal));
  let response: Response;
  const deadline = createDeadline(options);
  try {
    response = await Promise.race([
      Promise.resolve(fetchImpl(delivery.target.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Codex-Mimo-Event-Id": delivery.eventId,
          "X-Codex-Mimo-Signature": signWebhookBody(body, secret)
        },
        body,
        signal: deadline.signal
      })),
      deadline.expired
    ]);
  } catch {
    return { outcome: "retry", error: "Webhook request failed" };
  } finally {
    deadline.dispose();
  }

  if (response.status >= 200 && response.status < 300) {
    return { outcome: "delivered" };
  }

  const result = {
    error: `Webhook responded with HTTP ${response.status}`
  };
  return response.status === 408 ||
    response.status === 429 ||
    (response.status >= 500 && response.status <= 599)
    ? { outcome: "retry", ...result }
    : { outcome: "permanent", ...result };
}

function createDeadline(options: WebhookAttemptOptions): {
  signal: AbortSignal;
  expired: Promise<never>;
  dispose: () => void;
} {
  const controller = new AbortController();
  const schedule = options.scheduleTimeout ?? defaultScheduleTimeout;
  const cancel = options.cancelTimeout ?? defaultCancelTimeout;
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  let rejectExpired!: (error: Error) => void;
  const expired = new Promise<never>((_resolve, reject) => { rejectExpired = reject; });
  const onAbort = () => rejectExpired(new Error("Notification attempt ended"));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  options.signal?.addEventListener("abort", onParentAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = schedule(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    expired,
    dispose: () => {
      cancel(timer);
      options.signal?.removeEventListener("abort", onParentAbort);
      controller.signal.removeEventListener("abort", onAbort);
    }
  };
}

function defaultScheduleTimeout(
  callback: () => void,
  delayMs: number
): ReturnType<typeof setTimeout> {
  return setTimeout(callback, delayMs);
}

function defaultCancelTimeout(timer: unknown): void {
  clearTimeout(timer as ReturnType<typeof setTimeout>);
}
