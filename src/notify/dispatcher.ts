import path from "node:path";
import { readJob, resolveJobDir } from "../core/job-store.js";
import { isAttentionSignal, readJobSignals, type JobSignal } from "../core/job-signals.js";
import type { JobRecord } from "../core/jobs.js";
import {
  createCodexAppServerClient,
  type CodexAppServerClient,
  type CodexAppServerClientOptions
} from "./codex-app-server.js";
import { classifyCodexError, deliverCodexNotification } from "./codex-adapter.js";
import {
  claimDueDelivery,
  completeDelivery,
  failDelivery,
  readDeliveries,
  renewDeliveryLease,
  retryDelivery
} from "./outbox.js";
import {
  StaleDeliveryGenerationError,
  type DeliveryAttemptResult,
  type NotificationDelivery
} from "./types.js";
import { deliverWebhook } from "./webhook-adapter.js";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const MAX_RETRY_AGE_MS = 1_800_000;

export interface DispatcherDependencies {
  now?: () => Date;
  leaseMs?: number;
  attemptTimeoutMs?: number;
  deliver?: (
    delivery: NotificationDelivery,
    job: JobRecord,
    signal: JobSignal,
    attemptSignal: AbortSignal
  ) => Promise<DeliveryAttemptResult>;
  deliverWebhook?: typeof deliverWebhook;
  deliverCodex?: typeof deliverCodexNotification;
  createCodexClient?: (options?: CodexAppServerClientOptions) => CodexAppServerClient;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  renewDeliveryLease?: typeof renewDeliveryLease;
  completeDelivery?: typeof completeDelivery;
  scheduleLeaseRenewal?: (
    callback: () => Promise<void>,
    delayMs: number
  ) => unknown;
  cancelLeaseRenewal?: (timer: unknown) => void;
}

export type NotificationDispatchResult =
  | { outcome: "idle" }
  | { outcome: "settled"; delivery: NotificationDelivery }
  | { outcome: "stale"; delivery?: NotificationDelivery };

export interface JobNotificationSummary {
  type: NotificationDelivery["target"]["type"];
  status: NotificationDelivery["status"];
  attempts: number;
  lastError?: string;
  errorCode?: NotificationDelivery["lastErrorCode"];
}

export function retryDelayMs(attempts: number): number {
  if (attempts <= 1) return 10_000;
  if (attempts === 2) return 60_000;
  return 300_000;
}

export async function dispatchNextDelivery(
  cwd: string,
  dependencies: DispatcherDependencies = {}
): Promise<NotificationDispatchResult> {
  const claimedAt = readNow(dependencies);
  const outboxFile = path.join(resolveJobDir(cwd), "notifications.jsonl");
  const leaseMs = dependencies.leaseMs ?? DEFAULT_LEASE_MS;
  const claimed = await claimDueDelivery(
    outboxFile,
    claimedAt,
    leaseMs
  );
  if (!claimed) return { outcome: "idle" };

  const context = loadDeliveryContext(cwd, outboxFile, claimed);
  if ("error" in context) {
    return settleDelivery(outboxFile, claimed, () =>
      failDelivery(outboxFile, claimed.id, claimed.attempts, context.error)
    );
  }

  const heartbeat = startLeaseHeartbeat(outboxFile, claimed, leaseMs, dependencies);
  let result: DeliveryAttemptResult;
  try {
    result = dependencies.deliver
      ? await dependencies.deliver(claimed, context.job, context.signal, heartbeat.signal)
      : await deliverByTarget(
        claimed,
        context.job,
        context.signal,
        heartbeat.signal,
        leaseMs,
        dependencies
      );
  } catch {
    result = { outcome: "retry", error: "Notification delivery failed" };
  } finally {
    await heartbeat.stop();
  }
  if (heartbeat.ownershipLost()) return staleDispatchResult(outboxFile, claimed.id);

  const settledAt = readNow(dependencies);

  if (result.outcome === "delivered") {
    const complete = dependencies.completeDelivery ?? completeDelivery;
    return settleDelivery(outboxFile, claimed, () =>
      complete(outboxFile, claimed.id, claimed.attempts, settledAt)
    );
  }
  if (result.outcome === "permanent" ||
      settledAt.getTime() - Date.parse(claimed.createdAt) >= MAX_RETRY_AGE_MS) {
    return settleDelivery(outboxFile, claimed, () =>
      failDelivery(
        outboxFile,
        claimed.id,
        claimed.attempts,
        result.error,
        result.errorCode
      )
    );
  }

  return settleDelivery(outboxFile, claimed, () =>
    retryDelivery(
      outboxFile,
      claimed.id,
      claimed.attempts,
      new Date(settledAt.getTime() + retryDelayMs(claimed.attempts)),
      result.error,
      result.errorCode
    )
  );
}

export function summarizeJobNotification(
  job: JobRecord,
  deliveries: readonly NotificationDelivery[]
): JobNotificationSummary | undefined {
  const latest = deliveries
    .filter((delivery) => delivery.jobId === job.id)
    .reduce<NotificationDelivery | undefined>((selected, delivery) =>
      selected === undefined || delivery.signalCursor > selected.signalCursor
        ? delivery
        : selected, undefined);
  if (!latest) return undefined;

  return {
    type: latest.target.type,
    status: latest.status,
    attempts: latest.attempts,
    ...(latest.lastError === undefined ? {} : { lastError: latest.lastError }),
    ...(latest.lastErrorCode === undefined ? {} : { errorCode: latest.lastErrorCode })
  };
}

export function readNotificationDeliveries(cwd: string): NotificationDelivery[] {
  return readDeliveries(path.join(resolveJobDir(cwd), "notifications.jsonl"));
}

async function deliverByTarget(
  delivery: NotificationDelivery,
  job: JobRecord,
  jobSignal: JobSignal,
  attemptSignal: AbortSignal,
  leaseMs: number,
  dependencies: DispatcherDependencies
): Promise<DeliveryAttemptResult> {
  const timeoutMs = dependencies.attemptTimeoutMs ?? Math.max(
    1,
    Math.min(DEFAULT_ATTEMPT_TIMEOUT_MS, Math.floor(leaseMs / 2))
  );
  if (delivery.target.type === "webhook") {
    return (dependencies.deliverWebhook ?? deliverWebhook)(
      delivery,
      job,
      jobSignal,
      dependencies.env,
      dependencies.fetch,
      { signal: attemptSignal, timeoutMs }
    );
  }

  const client = (dependencies.createCodexClient ?? createCodexAppServerClient)({
    requestTimeoutMs: timeoutMs
  });
  return (dependencies.deliverCodex ?? deliverCodexNotification)(
    delivery,
    job,
    jobSignal,
    client,
    attemptSignal
  );
}

function loadDeliveryContext(
  cwd: string,
  outboxFile: string,
  delivery: NotificationDelivery
): { job: JobRecord; signal: JobSignal } | { error: string } {
  let job: JobRecord | undefined;
  try {
    job = readJob(cwd, delivery.jobId);
  } catch {
    return { error: "Notification job data is unavailable" };
  }
  if (!job ||
      job.cwd !== cwd ||
      path.resolve(job.notificationOutboxFile) !== path.resolve(outboxFile) ||
      !job.notificationTarget ||
      !sameTarget(job.notificationTarget, delivery.target)) {
    return { error: "Notification job data is unavailable" };
  }

  let signal: JobSignal | undefined;
  try {
    signal = readJobSignals(job.signalsFile).signals.find((candidate) =>
      candidate.cursor === delivery.signalCursor && candidate.jobId === delivery.jobId
    );
  } catch {
    return { error: "Notification signal data is unavailable" };
  }
  if (!signal ||
      !isAttentionSignal(signal) ||
      signal.kind !== job.status ||
      signal.status !== job.status) {
    return { error: "Notification signal data is unavailable" };
  }
  return { job, signal };
}

function sameTarget(
  left: JobRecord["notificationTarget"],
  right: NotificationDelivery["target"]
): boolean {
  if (!left || left.type !== right.type) return false;
  return left.type === "codex" && right.type === "codex"
    ? left.threadId === right.threadId
    : left.type === "webhook" && right.type === "webhook" &&
      left.url === right.url && left.secretEnv === right.secretEnv;
}

function startLeaseHeartbeat(
  file: string,
  delivery: NotificationDelivery,
  leaseMs: number,
  dependencies: DispatcherDependencies
): { signal: AbortSignal; stop: () => Promise<void>; ownershipLost: () => boolean } {
  const schedule = dependencies.scheduleLeaseRenewal ?? defaultScheduleLeaseRenewal;
  const cancel = dependencies.cancelLeaseRenewal ?? defaultCancelLeaseRenewal;
  const renew = dependencies.renewDeliveryLease ?? renewDeliveryLease;
  const intervalMs = Math.max(1, Math.floor(leaseMs / 3));
  let stopped = false;
  let lost = false;
  let timer: unknown;
  let timerScheduled = false;
  let inFlight: Promise<void> | undefined;
  const controller = new AbortController();

  const scheduleNext = (): void => {
    timer = schedule(tick, intervalMs);
    timerScheduled = true;
  };
  const tick = async (): Promise<void> => {
    timerScheduled = false;
    if (stopped || lost) return;

    const current = Promise.resolve().then(() => renew(
      file,
      delivery.id,
      delivery.attempts,
      readNow(dependencies),
      leaseMs
    )).then(
      () => undefined,
      () => {
        lost = true;
        controller.abort();
      }
    );
    inFlight = current;
    await current;
    if (inFlight === current) inFlight = undefined;
    if (!stopped && !lost) scheduleNext();
  };

  scheduleNext();
  return {
    signal: controller.signal,
    ownershipLost: () => lost,
    stop: async () => {
      stopped = true;
      if (timerScheduled) {
        cancel(timer);
        timerScheduled = false;
      }
      await inFlight;
    }
  };
}

async function settleDelivery(
  file: string,
  claimed: NotificationDelivery,
  settle: () => Promise<NotificationDelivery>
): Promise<NotificationDispatchResult> {
  try {
    return { outcome: "settled", delivery: await settle() };
  } catch (error) {
    if (error instanceof StaleDeliveryGenerationError) {
      return staleDispatchResult(file, claimed.id);
    }
    throw error;
  }
}

function staleDispatchResult(file: string, id: string): NotificationDispatchResult {
  const delivery = readDeliveries(file).find((candidate) => candidate.id === id);
  return delivery === undefined
    ? { outcome: "stale" }
    : { outcome: "stale", delivery };
}

function readNow(dependencies: DispatcherDependencies): Date {
  return dependencies.now?.() ?? new Date();
}

function defaultScheduleLeaseRenewal(
  callback: () => Promise<void>,
  delayMs: number
): ReturnType<typeof setTimeout> {
  return setTimeout(() => { void callback(); }, delayMs);
}

function defaultCancelLeaseRenewal(timer: unknown): void {
  clearTimeout(timer as ReturnType<typeof setTimeout>);
}
