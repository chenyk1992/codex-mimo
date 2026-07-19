import { listJobs, readJob } from "./job-store.js";
import {
  transitionJob,
  type JobTransitionResult
} from "./job-transition.js";
import { spawnNotificationWorker } from "./job-process.js";
import { startNotificationDispatch } from "../notify/dispatch-process.js";

const DEFAULT_STALE_THRESHOLD_MS = 300_000;

export interface StaleJobRecoveryOptions {
  staleThresholdMs?: number;
  now?: () => number;
  spawnNotificationWorker?: typeof spawnNotificationWorker;
  transitionJob?: typeof transitionJob;
}

export async function recoverStaleQueuedJobs(
  cwd: string,
  options: StaleJobRecoveryOptions = {}
): Promise<JobTransitionResult[]> {
  const threshold = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const cutoff = (options.now ?? Date.now)() - threshold;
  const recovered: JobTransitionResult[] = [];
  const transition = options.transitionJob ?? transitionJob;

  for (const job of listJobs(cwd)) {
    if (job.status !== "queued" || Date.parse(job.createdAt) >= cutoff) continue;
    const summary = `Job stuck in queued state for longer than ${Math.round(threshold / 1000)}s. Worker process may have failed to start.`;
    let result: JobTransitionResult;
    try {
      result = await transition(cwd, job.id, {
        status: "failed",
        summary,
        error: summary,
        errorCode: "stale_queued"
      });
    } catch (error) {
      const raced = readJob(cwd, job.id);
      if (raced?.status === "failed" && raced.errorCode === "stale_queued") continue;
      if (!raced || raced.status !== "queued") continue;
      throw error;
    }
    recovered.push(result);
    if (result.deliveryCreated) {
      startNotificationDispatch(cwd, {
        spawnNotificationWorker: options.spawnNotificationWorker
      });
    }
  }
  return recovered;
}
