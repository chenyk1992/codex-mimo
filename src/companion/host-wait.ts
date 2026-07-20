import fs from "node:fs";
import path from "node:path";

export const HOST_POLL_INTERVALS_MS = [30_000, 45_000, 60_000] as const;
export const HOST_POLL_CAP_MS = 60_000;
export const HOST_HOOK_SAFETY_PAD_MS = 10_000;
export const DEFAULT_JOB_TIMEOUT_MS = 1_800_000;

export const ATTENTION_STATUSES = new Set([
  "needs_input",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "timeout"
]);

export type JobStatusSnapshot = {
  status: string;
  phase?: string;
  startedAt?: string;
  requestTimeoutMs?: number;
};

export type HostWaitOutcome =
  | { type: "attention"; status: string }
  | { type: "exhausted"; status: string; waitedMs: number };

export function nextPollDelayMs(pollIndex: number): number {
  if (pollIndex < 0) return HOST_POLL_INTERVALS_MS[0]!;
  if (pollIndex >= HOST_POLL_INTERVALS_MS.length) return HOST_POLL_CAP_MS;
  return HOST_POLL_INTERVALS_MS[pollIndex]!;
}

export function computeWaitBudgetMs(input: {
  nowMs: number;
  hookTimeoutMs: number;
  jobStartedAt?: string;
  jobTimeoutMs?: number;
  envWaitSec?: number;
}): number {
  const hookBudget = Math.max(0, input.hookTimeoutMs - HOST_HOOK_SAFETY_PAD_MS);
  const jobTimeout = input.jobTimeoutMs && input.jobTimeoutMs > 0
    ? input.jobTimeoutMs
    : DEFAULT_JOB_TIMEOUT_MS;
  const started = input.jobStartedAt ? Date.parse(input.jobStartedAt) : Number.NaN;
  const jobRemaining = Number.isFinite(started)
    ? Math.max(0, started + jobTimeout - input.nowMs)
    : jobTimeout;
  const envBudget = typeof input.envWaitSec === "number" && Number.isFinite(input.envWaitSec) && input.envWaitSec > 0
    ? input.envWaitSec * 1000
    : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(hookBudget, jobRemaining, envBudget));
}

export function readJobStatusSnapshot(cwd: string, jobId: string): JobStatusSnapshot | undefined {
  const file = path.join(cwd, ".codex-mimo", "jobs", `${jobId}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof raw.status !== "string") return undefined;
    const request = raw.request && typeof raw.request === "object" && !Array.isArray(raw.request)
      ? raw.request as Record<string, unknown>
      : {};
    const requestTimeoutMs = typeof request.timeoutMs === "number" && Number.isFinite(request.timeoutMs)
      ? request.timeoutMs
      : undefined;
    return {
      status: raw.status,
      ...(typeof raw.phase === "string" ? { phase: raw.phase } : {}),
      ...(typeof raw.startedAt === "string" ? { startedAt: raw.startedAt } : {}),
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs })
    };
  } catch {
    return undefined;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function awaitJobAttention(options: {
  cwd: string;
  jobId: string;
  budgetMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readJob?: typeof readJobStatusSnapshot;
  isAttention?: (status: string) => boolean;
}): Promise<HostWaitOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const readJob = options.readJob ?? readJobStatusSnapshot;
  const isAttention = options.isAttention ?? ((status) => ATTENTION_STATUSES.has(status));
  const startedAt = now();
  const deadline = startedAt + Math.max(0, options.budgetMs);
  let pollIndex = 0;
  let lastStatus = "running";

  for (;;) {
    const snap = readJob(options.cwd, options.jobId);
    if (snap) lastStatus = snap.status;
    if (snap && isAttention(snap.status)) {
      return { type: "attention", status: snap.status };
    }
    const t = now();
    if (t >= deadline) {
      return { type: "exhausted", status: lastStatus, waitedMs: Math.max(0, t - startedAt) };
    }
    const delay = Math.min(nextPollDelayMs(pollIndex), Math.max(1, deadline - t));
    pollIndex += 1;
    await sleep(delay);
  }
}
