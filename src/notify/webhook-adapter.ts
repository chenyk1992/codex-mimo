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
      summary: job.summary ?? signal.summary
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
  fetchImpl: typeof fetch = globalThis.fetch
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
  try {
    response = await fetchImpl(delivery.target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Codex-Mimo-Event-Id": delivery.eventId,
        "X-Codex-Mimo-Signature": signWebhookBody(body, secret)
      },
      body
    });
  } catch {
    return { outcome: "retry", error: "Webhook request failed" };
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
