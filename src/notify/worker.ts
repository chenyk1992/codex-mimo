import type { DispatcherDependencies } from "./dispatcher.js";
import {
  dispatchNextDelivery,
  readNotificationDeliveries
} from "./dispatcher.js";
import {
  ProcessLockUnavailableError,
  resolveProcessLockEndpoint,
  withProcessLock
} from "../core/process-lock.js";
import { resolveNotificationWorkerOwnershipKey } from "../core/worker-ownership.js";

const CONCURRENT_WORKER_RETRY_MS = 1;

export interface NotificationWorkerDependencies extends DispatcherDependencies {
  sleep?: (delayMs: number) => Promise<void>;
}

export async function runNotificationWorker(
  cwd: string,
  dependencies: NotificationWorkerDependencies = {}
): Promise<void> {
  const ownershipKey = resolveNotificationWorkerOwnershipKey(cwd);
  const ownershipEndpoint = resolveProcessLockEndpoint(ownershipKey);
  try {
    await withProcessLock(
      ownershipKey,
      () => runOwnedNotificationWorker(cwd, dependencies),
      { timeoutMs: 0 }
    );
  } catch (error) {
    if (error instanceof ProcessLockUnavailableError &&
        error.key === ownershipKey &&
        error.endpoint.host === ownershipEndpoint.host &&
        error.endpoint.port === ownershipEndpoint.port) {
      return;
    }
    throw error;
  }
}

async function runOwnedNotificationWorker(
  cwd: string,
  dependencies: NotificationWorkerDependencies
): Promise<void> {
  const sleep = dependencies.sleep ?? defaultSleep;

  while (true) {
    const dispatched = await dispatchNextDelivery(cwd, dependencies);
    if (dispatched.outcome !== "idle") continue;

    const now = dependencies.now?.() ?? new Date();
    const unfinished = readNotificationDeliveries(cwd)
      .filter((delivery) => delivery.status === "pending" || delivery.status === "delivering");
    if (unfinished.length === 0) return;

    const nextReadyAt = Math.min(...unfinished.map((delivery) => {
      const timestamp = delivery.status === "pending"
        ? delivery.nextAttemptAt
        : delivery.leaseUntil;
      return timestamp === undefined ? now.getTime() : Date.parse(timestamp);
    }));
    await sleep(Math.max(CONCURRENT_WORKER_RETRY_MS, nextReadyAt - now.getTime()));
  }
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
