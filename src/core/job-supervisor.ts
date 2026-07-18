import path from "node:path";
import { readNotificationDeliveries } from "../notify/dispatcher.js";
import {
  listJobs,
  resolveJobDir
} from "./job-store.js";
import {
  spawnJobWorker,
  spawnNotificationWorker
} from "./job-process.js";
import { isActiveJobStatus, type JobRecord } from "./jobs.js";
import {
  ProcessLockUnavailableError,
  resolveProcessLockEndpoint,
  withProcessLock
} from "./process-lock.js";

const DEFAULT_POLL_INTERVAL_MS = 100;
const OWNERSHIP_HANDOFF_TIMEOUT_MS = 250;

export interface JobSupervisorDependencies {
  listJobs?: typeof listJobs;
  readNotificationDeliveries?: typeof readNotificationDeliveries;
  spawnJobWorker?: typeof spawnJobWorker;
  spawnNotificationWorker?: typeof spawnNotificationWorker;
  processIsRunning?: (pid: number) => boolean;
  sleep?: (delayMs: number) => Promise<void>;
  pollIntervalMs?: number;
}

export async function runJobSupervisor(
  cwd: string,
  dependencies: JobSupervisorDependencies = {}
): Promise<void> {
  const ownershipKey = path.join(resolveJobDir(cwd), "supervisor-ownership");
  const endpoint = resolveProcessLockEndpoint(ownershipKey);
  while (true) {
    try {
      await withProcessLock(
        ownershipKey,
        () => runOwnedSupervisor(cwd, dependencies),
        { timeoutMs: OWNERSHIP_HANDOFF_TIMEOUT_MS }
      );
      return;
    } catch (error) {
      if (!(error instanceof ProcessLockUnavailableError) ||
          error.key !== ownershipKey ||
          error.endpoint.host !== endpoint.host ||
          error.endpoint.port !== endpoint.port) {
        throw error;
      }
      if (!hasUnfinishedWork(cwd, dependencies)) return;
    }
  }
}

function hasUnfinishedWork(
  cwd: string,
  dependencies: JobSupervisorDependencies
): boolean {
  const readJobs = dependencies.listJobs ?? listJobs;
  if (readJobs(cwd).some(isSupervisedJob)) return true;
  const readDeliveries = dependencies.readNotificationDeliveries ?? readNotificationDeliveries;
  return readDeliveries(cwd).some(isDeliveryUnfinished);
}

async function runOwnedSupervisor(
  cwd: string,
  dependencies: JobSupervisorDependencies
): Promise<void> {
  const readJobs = dependencies.listJobs ?? listJobs;
  const readDeliveries = dependencies.readNotificationDeliveries ?? readNotificationDeliveries;
  const startJobWorker = dependencies.spawnJobWorker ?? spawnJobWorker;
  const startNotificationWorker = dependencies.spawnNotificationWorker ?? spawnNotificationWorker;
  const isRunning = dependencies.processIsRunning ?? processIsRunning;
  const sleep = dependencies.sleep ?? defaultSleep;
  const pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const jobWorkers = new Map<string, number>();
  let notificationWorker: number | undefined;

  while (true) {
    const supervisedJobs = readJobs(cwd).filter(isSupervisedJob);
    const supervisedIds = new Set(supervisedJobs.map((job) => job.id));
    for (const jobId of jobWorkers.keys()) {
      if (!supervisedIds.has(jobId)) jobWorkers.delete(jobId);
    }
    for (const job of supervisedJobs) {
      const pid = jobWorkers.get(job.id);
      if (pid !== undefined && isRunning(pid)) continue;
      const replacement = trySpawn(() => startJobWorker(cwd, job.id));
      if (replacement !== undefined) jobWorkers.set(job.id, replacement);
      else jobWorkers.delete(job.id);
    }

    const unfinishedDeliveries = readDeliveries(cwd).filter(isDeliveryUnfinished);
    if (unfinishedDeliveries.length > 0 &&
        (notificationWorker === undefined || !isRunning(notificationWorker))) {
      notificationWorker = trySpawn(() => startNotificationWorker(cwd));
    }

    if (supervisedJobs.length === 0 && unfinishedDeliveries.length === 0) return;
    await sleep(pollIntervalMs);
  }
}

function isSupervisedJob(job: JobRecord): boolean {
  return isActiveJobStatus(job.status) || job.pendingTransition !== undefined;
}

function isDeliveryUnfinished(delivery: { status: string }): boolean {
  return delivery.status === "pending" || delivery.status === "delivering";
}

function trySpawn(spawn: () => number): number | undefined {
  try {
    const pid = spawn();
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrorWithCode(error, "EPERM");
  }
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
