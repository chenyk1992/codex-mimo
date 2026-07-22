import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { withProcessLock } from "../core/process-lock.js";
import { renameWithWindowsRetry } from "../core/atomic-file.js";
import type {
  EnqueueDeliveryInput,
  NotificationDelivery,
  NotificationErrorCode,
  NotificationTarget
} from "./types.js";
import { isNotificationErrorCode, StaleDeliveryGenerationError as StaleGenerationError } from "./types.js";

export interface EnqueueDeliveryResult {
  delivery: NotificationDelivery;
  created: boolean;
}

export function enqueueDelivery(
  file: string,
  input: EnqueueDeliveryInput
): Promise<EnqueueDeliveryResult> {
  return withProcessLock(file, () => {
    const id = `${input.jobId}:${input.signalCursor}:${input.target.type}`;
    const existing = readDeliveriesForMutation(file).find((delivery) => delivery.id === id);
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
  return replayDeliveryJournal(file).deliveries;
}

interface DeliveryJournalReplay {
  deliveries: NotificationDelivery[];
  requiresRewrite: boolean;
}

function replayDeliveryJournal(file: string): DeliveryJournalReplay {
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return { deliveries: [], requiresRewrite: false };
    throw error;
  }

  const deliveries = new Map<string, NotificationDelivery>();
  let requiresRewrite = false;
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseDeliveryLine(line);
    if (parsed) {
      deliveries.set(parsed.delivery.id, parsed.delivery);
      if (parsed.requiresRewrite) requiresRewrite = true;
    } else {
      requiresRewrite = true;
    }
  }
  return { deliveries: [...deliveries.values()], requiresRewrite };
}

function readDeliveriesForMutation(file: string): NotificationDelivery[] {
  const replay = replayDeliveryJournal(file);
  if (replay.requiresRewrite) rewriteDeliveryJournal(file, replay.deliveries);
  return replay.deliveries;
}

export function claimDueDelivery(
  file: string,
  now: Date,
  leaseMs: number
): Promise<NotificationDelivery | undefined> {
  return withProcessLock(file, () => {
    const delivery = readDeliveriesForMutation(file).find((candidate) => isDue(candidate, now));
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
): Promise<NotificationDelivery> {
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

export function renewDeliveryLease(
  file: string,
  id: string,
  expectedAttempt: number,
  now: Date,
  leaseMs: number
): Promise<NotificationDelivery> {
  return updateDelivery(file, id, expectedAttempt, (delivery) => {
    const currentLeaseUntil = Date.parse(delivery.leaseUntil!);
    const renewedLeaseUntil = now.getTime() + leaseMs;
    return {
      ...delivery,
      leaseUntil: new Date(Math.max(currentLeaseUntil, renewedLeaseUntil)).toISOString()
    };
  });
}

export function retryDelivery(
  file: string,
  id: string,
  expectedAttempt: number,
  nextAttemptAt: Date,
  lastError: string,
  errorCode?: NotificationErrorCode
): Promise<NotificationDelivery> {
  return updateDelivery(file, id, expectedAttempt, (delivery) => {
    const retried: NotificationDelivery = {
      ...delivery,
      status: "pending",
      nextAttemptAt: nextAttemptAt.toISOString(),
      lastError
    };
    delete retried.leaseUntil;
    delete retried.deliveredAt;
    if (errorCode !== undefined) {
      retried.lastErrorCode = errorCode;
    } else {
      delete retried.lastErrorCode;
    }
    return retried;
  });
}

export function failDelivery(
  file: string,
  id: string,
  expectedAttempt: number,
  lastError: string,
  errorCode?: NotificationErrorCode
): Promise<NotificationDelivery> {
  return updateDelivery(file, id, expectedAttempt, (delivery) => {
    const failed: NotificationDelivery = {
      ...delivery,
      status: "failed",
      lastError
    };
    delete failed.leaseUntil;
    delete failed.nextAttemptAt;
    delete failed.deliveredAt;
    if (errorCode !== undefined) {
      failed.lastErrorCode = errorCode;
    } else {
      delete failed.lastErrorCode;
    }
    return failed;
  });
}

function updateDelivery(
  file: string,
  id: string,
  expectedAttempt: number,
  update: (delivery: NotificationDelivery) => NotificationDelivery
): Promise<NotificationDelivery> {
  return withProcessLock(file, () => {
    const delivery = readDeliveriesForMutation(file).find((candidate) => candidate.id === id);
    if (!delivery) {
      throw new StaleGenerationError(`Notification delivery not found: ${id}`);
    }
    if (delivery.status !== "delivering") {
      throw new StaleGenerationError(`Notification delivery is not delivering: ${id}`);
    }
    if (delivery.attempts !== expectedAttempt) {
      throw new StaleGenerationError(
        `Notification delivery lease generation does not match: ${id}`
      );
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

function rewriteDeliveryJournal(file: string, deliveries: NotificationDelivery[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const contents = deliveries.length === 0
    ? ""
    : `${deliveries.map((delivery) => JSON.stringify(delivery)).join("\n")}\n`;
  try {
    fs.writeFileSync(temporary, contents, "utf8");
    renameWithWindowsRetry(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
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

function parseDeliveryLine(
  line: string
): { delivery: NotificationDelivery; requiresRewrite: boolean } | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    const delivery = sanitizeNotificationDelivery(value);
    return delivery
      ? { delivery, requiresRewrite: !isDeepStrictEqual(value, delivery) }
      : undefined;
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
  if (isNotificationErrorCode(value.lastErrorCode)) {
    delivery.lastErrorCode = value.lastErrorCode;
  }
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
