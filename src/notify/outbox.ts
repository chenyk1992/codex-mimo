import fs from "node:fs";
import path from "node:path";
import type {
  EnqueueDeliveryInput,
  NotificationDelivery,
  NotificationTarget
} from "./types.js";

const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 10;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export function enqueueDelivery(
  file: string,
  input: EnqueueDeliveryInput
): NotificationDelivery {
  return withJournalLock(file, () => {
    const id = `${input.jobId}:${input.signalCursor}:${input.target.type}`;
    const existing = readDeliveries(file).find((delivery) => delivery.id === id);
    if (existing) return existing;

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
    return delivery;
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
  return withJournalLock(file, () => {
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
  deliveredAt: Date
): NotificationDelivery {
  return updateDelivery(file, id, (delivery) => {
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
  nextAttemptAt: Date,
  lastError: string
): NotificationDelivery {
  return updateDelivery(file, id, (delivery) => {
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
  lastError: string
): NotificationDelivery {
  return updateDelivery(file, id, (delivery) => {
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
  update: (delivery: NotificationDelivery) => NotificationDelivery
): NotificationDelivery {
  return withJournalLock(file, () => {
    const delivery = readDeliveries(file).find((candidate) => candidate.id === id);
    if (!delivery) throw new Error(`Notification delivery not found: ${id}`);
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
  fs.appendFileSync(file, `${JSON.stringify(delivery)}\n`, "utf8");
}

function withJournalLock<T>(file: string, action: () => T): T {
  const directory = path.dirname(file);
  const lockFile = path.join(directory, "notifications.lock");
  fs.mkdirSync(directory, { recursive: true });

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let descriptor: number;
  while (true) {
    try {
      descriptor = fs.openSync(lockFile, "wx");
      break;
    } catch (error) {
      if (!isFileExistsError(error) || Date.now() >= deadline) throw error;
      Atomics.wait(lockWaitArray, 0, 0, LOCK_RETRY_MS);
    }
  }

  try {
    return action();
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lockFile, { force: true });
  }
}

function parseDeliveryLine(line: string): NotificationDelivery | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return isNotificationDelivery(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isNotificationDelivery(value: unknown): value is NotificationDelivery {
  if (!isRecord(value) || !isNotificationTarget(value.target)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.eventId === "string" &&
    typeof value.jobId === "string" &&
    typeof value.signalCursor === "number" &&
    Number.isInteger(value.signalCursor) &&
    value.signalCursor >= 0 &&
    (value.status === "pending" ||
      value.status === "delivering" ||
      value.status === "delivered" ||
      value.status === "failed") &&
    typeof value.attempts === "number" &&
    Number.isInteger(value.attempts) &&
    value.attempts >= 0 &&
    typeof value.createdAt === "string" &&
    isOptionalString(value.nextAttemptAt) &&
    isOptionalString(value.leaseUntil) &&
    isOptionalString(value.deliveredAt) &&
    isOptionalString(value.lastError)
  );
}

function isNotificationTarget(value: unknown): value is NotificationTarget {
  if (!isRecord(value)) return false;
  if (value.type === "codex") return typeof value.threadId === "string";
  return value.type === "webhook" &&
    typeof value.url === "string" &&
    typeof value.secretEnv === "string";
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

function isMissingFileError(error: unknown): boolean {
  return isErrorWithCode(error, "ENOENT");
}

function isFileExistsError(error: unknown): boolean {
  return isErrorWithCode(error, "EEXIST");
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
