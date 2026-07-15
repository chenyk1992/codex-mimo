import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "../core/file-lock.js";
import type {
  EnqueueDeliveryInput,
  NotificationDelivery,
  NotificationTarget
} from "./types.js";

export interface EnqueueDeliveryResult {
  delivery: NotificationDelivery;
  created: boolean;
}

export function enqueueDelivery(
  file: string,
  input: EnqueueDeliveryInput
): EnqueueDeliveryResult {
  return withFileLock(resolveOutboxLock(file), () => {
    const id = `${input.jobId}:${input.signalCursor}:${input.target.type}`;
    const existing = readDeliveries(file).find((delivery) => delivery.id === id);
    if (existing) return { delivery: existing, created: false };

    const delivery: NotificationDelivery = {
      id,
      eventId: id,
      jobId: input.jobId,
      signalCursor: input.signalCursor,
      target: cloneTarget(input.target),
      status: "pending",
      attempts: 0,
      createdAt: input.createdAt
    };
    appendSnapshot(file, delivery);
    return { delivery, created: true };
  });
}

export function readDeliveries(file: string): NotificationDelivery[] {
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }

  const deliveries = new Map<string, NotificationDelivery>();
  for (const line of contents.split(/\r?\n/)) {
    const delivery = parseDeliveryLine(line);
    if (delivery) deliveries.set(delivery.id, delivery);
  }
  return [...deliveries.values()];
}

export function claimDueDelivery(
  file: string,
  now: Date,
  leaseMs: number
): NotificationDelivery | undefined {
  return withFileLock(resolveOutboxLock(file), () => {
    const delivery = readDeliveries(file).find((candidate) => isDue(candidate, now));
    if (!delivery) return undefined;

    const claimed: NotificationDelivery = {
      ...delivery,
      status: "delivering",
      attempts: delivery.attempts + 1,
      leaseUntil: new Date(now.getTime() + leaseMs).toISOString()
    };
    delete claimed.nextAttemptAt;
    delete claimed.deliveredAt;
    appendSnapshot(file, claimed);
    return claimed;
  });
}

export function completeDelivery(
  file: string,
  id: string,
  expectedAttempt: number,
  deliveredAt: Date
): NotificationDelivery {
  return updateDelivery(file, id, expectedAttempt, (delivery) => {
    const completed: NotificationDelivery = {
      ...delivery,
      status: "delivered",
      deliveredAt: deliveredAt.toISOString()
    };
    delete completed.leaseUntil;
    delete completed.nextAttemptAt;
    return completed;
  });
}

export function retryDelivery(
  file: string,
  id: string,
  expectedAttempt: number,
  nextAttemptAt: Date,
  lastError: string
): NotificationDelivery {
  return updateDelivery(file, id, expectedAttempt, (delivery) => {
    const retried: NotificationDelivery = {
      ...delivery,
      status: "pending",
      nextAttemptAt: nextAttemptAt.toISOString(),
      lastError
    };
    delete retried.leaseUntil;
    delete retried.deliveredAt;
    return retried;
  });
}

export function failDelivery(
  file: string,
  id: string,
  expectedAttempt: number,
  lastError: string
): NotificationDelivery {
  return updateDelivery(file, id, expectedAttempt, (delivery) => {
    const failed: NotificationDelivery = {
      ...delivery,
      status: "failed",
      lastError
    };
    delete failed.leaseUntil;
    delete failed.nextAttemptAt;
    delete failed.deliveredAt;
    return failed;
  });
}

function updateDelivery(
  file: string,
  id: string,
  expectedAttempt: number,
  update: (delivery: NotificationDelivery) => NotificationDelivery
): NotificationDelivery {
  return withFileLock(resolveOutboxLock(file), () => {
    const delivery = readDeliveries(file).find((candidate) => candidate.id === id);
    if (!delivery) throw new Error(`Notification delivery not found: ${id}`);
    if (delivery.status !== "delivering") {
      throw new Error(`Notification delivery is not delivering: ${id}`);
    }
    if (delivery.attempts !== expectedAttempt) {
      throw new Error(`Notification delivery lease generation does not match: ${id}`);
    }
    const updated = update(delivery);
    appendSnapshot(file, updated);
    return updated;
  });
}

function isDue(delivery: NotificationDelivery, now: Date): boolean {
  if (delivery.status === "pending") {
    return delivery.nextAttemptAt === undefined || Date.parse(delivery.nextAttemptAt) <= now.getTime();
  }
  if (delivery.status === "delivering" && delivery.leaseUntil !== undefined) {
    return Date.parse(delivery.leaseUntil) <= now.getTime();
  }
  return false;
}

function appendSnapshot(file: string, delivery: NotificationDelivery): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ensureLineBoundary(file);
  fs.appendFileSync(file, `${JSON.stringify(delivery)}\n`, "utf8");
}

function ensureLineBoundary(file: string): void {
  try {
    const contents = fs.readFileSync(file);
    if (contents.length > 0 && contents[contents.length - 1] !== 0x0a) {
      fs.appendFileSync(file, "\n", "utf8");
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

function resolveOutboxLock(file: string): string {
  return path.join(path.dirname(file), "notifications.lock");
}

function parseDeliveryLine(line: string): NotificationDelivery | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return sanitizeNotificationDelivery(value);
  } catch {
    return undefined;
  }
}

function sanitizeNotificationDelivery(value: unknown): NotificationDelivery | undefined {
  if (!isRecord(value)) return undefined;
  const target = sanitizeNotificationTarget(value.target);
  if (
    !target ||
    typeof value.id !== "string" ||
    typeof value.eventId !== "string" ||
    typeof value.jobId !== "string" ||
    typeof value.signalCursor !== "number" ||
    !Number.isInteger(value.signalCursor) ||
    value.signalCursor < 0
  ) {
    return undefined;
  }

  const expectedId = `${value.jobId}:${value.signalCursor}:${target.type}`;
  if (
    value.id !== expectedId ||
    value.eventId !== expectedId ||
    (value.status !== "pending" &&
      value.status !== "delivering" &&
      value.status !== "delivered" &&
      value.status !== "failed") ||
    typeof value.attempts !== "number" ||
    !Number.isInteger(value.attempts) ||
    value.attempts < 0 ||
    !isTimestamp(value.createdAt) ||
    !isOptionalTimestamp(value.nextAttemptAt) ||
    !isOptionalTimestamp(value.leaseUntil) ||
    !isOptionalTimestamp(value.deliveredAt) ||
    !isOptionalString(value.lastError) ||
    !hasValidStatusFields(value)
  ) {
    return undefined;
  }

  const delivery: NotificationDelivery = {
    id: value.id,
    eventId: value.eventId,
    jobId: value.jobId,
    signalCursor: value.signalCursor,
    target,
    status: value.status,
    attempts: value.attempts,
    createdAt: value.createdAt
  };
  if (typeof value.nextAttemptAt === "string") delivery.nextAttemptAt = value.nextAttemptAt;
  if (typeof value.leaseUntil === "string") delivery.leaseUntil = value.leaseUntil;
  if (typeof value.deliveredAt === "string") delivery.deliveredAt = value.deliveredAt;
  if (typeof value.lastError === "string") delivery.lastError = value.lastError;
  return delivery;
}

function sanitizeNotificationTarget(value: unknown): NotificationTarget | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "codex" && typeof value.threadId === "string") {
    return { type: "codex", threadId: value.threadId };
  }
  if (
    value.type === "webhook" &&
    typeof value.url === "string" &&
    typeof value.secretEnv === "string"
  ) {
    return { type: "webhook", url: value.url, secretEnv: value.secretEnv };
  }
  return undefined;
}

function hasValidStatusFields(value: Record<string, unknown>): boolean {
  if (typeof value.attempts !== "number") return false;
  switch (value.status) {
    case "pending":
      return value.leaseUntil === undefined &&
        value.deliveredAt === undefined &&
        (value.nextAttemptAt === undefined || value.attempts > 0);
    case "delivering":
      return value.attempts > 0 &&
        value.leaseUntil !== undefined &&
        value.nextAttemptAt === undefined &&
        value.deliveredAt === undefined;
    case "delivered":
      return value.attempts > 0 &&
        value.deliveredAt !== undefined &&
        value.leaseUntil === undefined &&
        value.nextAttemptAt === undefined;
    case "failed":
      return value.attempts > 0 &&
        value.leaseUntil === undefined &&
        value.nextAttemptAt === undefined &&
        value.deliveredAt === undefined;
    default:
      return false;
  }
}

function cloneTarget(target: NotificationTarget): NotificationTarget {
  return target.type === "codex"
    ? { type: "codex", threadId: target.threadId }
    : { type: "webhook", url: target.url, secretEnv: target.secretEnv };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isTimestamp(value);
}

function isMissingFileError(error: unknown): boolean {
  return isErrorWithCode(error, "ENOENT");
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
