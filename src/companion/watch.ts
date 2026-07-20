import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ATTENTION_STATUSES,
  awaitJobAttention,
  computeWaitBudgetMs,
  readJobStatusSnapshot
} from "./host-wait.js";

export { ATTENTION_STATUSES };

export const WORK_TOOLS = new Set([
  "mimo_plan",
  "mimo_implement",
  "mimo_review",
  "mimo_fix_ci",
  "mimo_resume",
  "mimo_compose"
]);

export const ACTIVE_STATUSES = new Set(["queued", "running"]);

export interface CompanionWatch {
  cwd: string;
  jobId: string;
  kind?: string;
  createdAt: string;
  conversationId?: string;
  waitStartedAt?: string;
  lastPolledAt?: string;
}
export interface CompanionWatchState {
  version: 1;
  watches: CompanionWatch[];
  acked: Record<string, { status: string; ackedAt: string }>;
}

export interface WorkReceipt {
  cwd: string;
  jobId: string;
  kind: string;
}

export function watchStatePath(home = os.homedir()): string {
  return path.join(home, ".codex-mimo", "companion-watch.json");
}

export function emptyState(): CompanionWatchState {
  return { version: 1, watches: [], acked: {} };
}

export function readState(file: string): CompanionWatchState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CompanionWatchState>;
    if (!parsed || typeof parsed !== "object") return emptyState();
    return {
      version: 1,
      watches: Array.isArray(parsed.watches) ? parsed.watches : [],
      acked: parsed.acked && typeof parsed.acked === "object" ? parsed.acked : {}
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return emptyState();
    }
    return emptyState();
  }
}

export function writeState(file: string, state: CompanionWatchState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function watchKey(cwd: string, jobId: string): string {
  return `${path.resolve(cwd)}::${jobId}`;
}

export function parseJsonMaybe(value: unknown): unknown {
  if (value == null) return undefined;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function normalizeToolName(toolName: unknown): string {
  if (typeof toolName !== "string") return "";
  const trimmed = toolName.trim();
  const mcp = trimmed.match(/^MCP:\s*(.+)$/i);
  if (mcp) return mcp[1].trim();
  const parts = trimmed.split(/[/:]/);
  return parts[parts.length - 1]?.trim() ?? "";
}

/** Accept string/object payloads and one-level wrappers used by some MCP hosts. */
export function unwrapToolResult(resultJson: unknown): Record<string, unknown> {
  const parsed = parseJsonMaybe(resultJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  if (typeof record.jobId === "string") return record;
  for (const key of ["result", "data", "output"]) {
    const nestedParsed = parseJsonMaybe(record[key]);
    if (nestedParsed && typeof nestedParsed === "object" && !Array.isArray(nestedParsed)) {
      const nestedRecord = nestedParsed as Record<string, unknown>;
      if (typeof nestedRecord.jobId === "string") return nestedRecord;
    }
  }
  return record;
}

export function extractWorkReceipt(
  toolName: unknown,
  toolInput: unknown,
  resultJson: unknown
): WorkReceipt | undefined {
  const name = normalizeToolName(toolName);
  if (!WORK_TOOLS.has(name)) return undefined;
  const input = (parseJsonMaybe(toolInput) ?? {}) as Record<string, unknown>;
  const result = unwrapToolResult(resultJson);
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  const jobId = typeof result.jobId === "string" ? result.jobId.trim() : "";
  if (!cwd || !jobId) return undefined;
  return {
    cwd,
    jobId,
    kind: typeof result.kind === "string" ? result.kind : name.replace(/^mimo_/, "")
  };
}

export function upsertWatch(
  state: CompanionWatchState,
  watch: CompanionWatch
): CompanionWatchState {
  const key = watchKey(watch.cwd, watch.jobId);
  const watches = state.watches.filter((item) => watchKey(item.cwd, item.jobId) !== key);
  watches.push({
    cwd: path.resolve(watch.cwd),
    jobId: watch.jobId,
    kind: watch.kind,
    createdAt: watch.createdAt,
    ...(watch.conversationId ? { conversationId: watch.conversationId } : {})
  });
  // Re-watching the same job must allow a fresh attention follow-up.
  const acked = { ...state.acked };
  delete acked[key];
  return { ...state, watches, acked };
}

export function readJobRecord(cwd: string, jobId: string): { status?: string; updatedAt?: string } | undefined {
  const file = path.join(cwd, ".codex-mimo", "jobs", `${jobId}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as { status?: string; updatedAt?: string };
  } catch {
    return undefined;
  }
}

export interface StopDecision {
  followup?: string;
  nextState: CompanionWatchState;
}

export const MAX_FOLLOWUP_CHARS = 400;

export function formatAttentionFollowup(cwd: string, jobId: string, status: string): string {
  const text = [
    `MiMo job ${jobId} needs attention (status=${status}).`,
    `Call mimo_result with {"cwd":${JSON.stringify(cwd)},"jobId":${JSON.stringify(jobId)}}.`,
    "Summarize for the user; do not invent outcomes. If needs_input/blocked, ask user then mimo_resume."
  ].join(" ");
  return text.slice(0, MAX_FOLLOWUP_CHARS);
}

export function formatExhaustedFollowup(jobId: string, status: string): string {
  const text = [
    `MiMo job ${jobId} still ${status} after host wait.`,
    "Call mimo_status once OR mimo_cancel. Do not loop wait/events. Report to user."
  ].join(" ");
  return text.slice(0, MAX_FOLLOWUP_CHARS);
}

function resolveNow(now?: Date | (() => Date)): () => Date {
  return typeof now === "function" ? now : () => now ?? new Date();
}

function defaultEnvWaitSec(): number | undefined {
  const raw = Number(process.env.CODEX_MIMO_COMPANION_WAIT_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export async function decideStopFollowup(
  state: CompanionWatchState,
  options: {
    now?: Date | (() => Date);
    hookStatus?: string;
    hookTimeoutMs?: number;
    envWaitSec?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<StopDecision> {
  const nowFn = resolveNow(options.now);
  const status = options.hookStatus ?? "completed";
  if (status === "aborted") {
    return { followup: undefined, nextState: state };
  }

  const next: CompanionWatchState = {
    version: 1,
    watches: [...state.watches],
    acked: { ...state.acked }
  };

  // 1) Prefer immediate unacked attention (no block)
  for (const watch of next.watches) {
    const job = readJobRecord(watch.cwd, watch.jobId);
    if (!job || typeof job.status !== "string") continue;
    if (!ATTENTION_STATUSES.has(job.status)) continue;
    const key = watchKey(watch.cwd, watch.jobId);
    if (next.acked[key]?.status === job.status) continue;
    const now = nowFn();
    next.acked[key] = { status: job.status, ackedAt: now.toISOString() };
    next.watches = next.watches.filter((item) => watchKey(item.cwd, item.jobId) !== key);
    return {
      followup: formatAttentionFollowup(watch.cwd, watch.jobId, job.status),
      nextState: next
    };
  }

  // Drop missing / terminal / already-acked watches; keep only active for host wait.
  const activeWatches: CompanionWatch[] = [];
  for (const watch of next.watches) {
    const job = readJobRecord(watch.cwd, watch.jobId);
    if (!job || typeof job.status !== "string") continue;
    if (ACTIVE_STATUSES.has(job.status)) activeWatches.push(watch);
  }
  next.watches = activeWatches;

  // 2) Else pick first active watch (FIFO), compute budget, awaitJobAttention
  const activeWatch = next.watches[0];
  if (!activeWatch) {
    return { followup: undefined, nextState: next };
  }

  const snap = readJobStatusSnapshot(activeWatch.cwd, activeWatch.jobId);
  const now = nowFn();
  const hookTimeoutMs = typeof options.hookTimeoutMs === "number" && Number.isFinite(options.hookTimeoutMs)
    ? options.hookTimeoutMs
    : 1_860_000;
  const envWaitSec = typeof options.envWaitSec === "number" && Number.isFinite(options.envWaitSec) && options.envWaitSec > 0
    ? options.envWaitSec
    : defaultEnvWaitSec();
  const budgetMs = computeWaitBudgetMs({
    nowMs: now.getTime(),
    hookTimeoutMs,
    jobStartedAt: snap?.startedAt,
    jobTimeoutMs: snap?.requestTimeoutMs,
    envWaitSec
  });

  const waitStartedAt = now.toISOString();
  next.watches = next.watches.map((watch) =>
    watchKey(watch.cwd, watch.jobId) === watchKey(activeWatch.cwd, activeWatch.jobId)
      ? { ...watch, waitStartedAt, lastPolledAt: waitStartedAt }
      : watch
  );

  const outcome = await awaitJobAttention({
    cwd: activeWatch.cwd,
    jobId: activeWatch.jobId,
    budgetMs,
    now: () => nowFn().getTime(),
    ...(options.sleep ? { sleep: options.sleep } : {})
  });

  const after = nowFn();
  const key = watchKey(activeWatch.cwd, activeWatch.jobId);

  if (outcome.type === "attention") {
    // 3) attention → formatAttentionFollowup + ack status
    next.acked[key] = { status: outcome.status, ackedAt: after.toISOString() };
    next.watches = next.watches.filter((item) => watchKey(item.cwd, item.jobId) !== key);
    return {
      followup: formatAttentionFollowup(activeWatch.cwd, activeWatch.jobId, outcome.status),
      nextState: next
    };
  }

  // 4) exhausted → formatExhaustedFollowup + remove watch + ack "exhausted"
  next.acked[key] = { status: "exhausted", ackedAt: after.toISOString() };
  next.watches = next.watches.filter((item) => watchKey(item.cwd, item.jobId) !== key);
  return {
    followup: formatExhaustedFollowup(activeWatch.jobId, outcome.status),
    nextState: next
  };
}

export function handleAfterMcp(
  stdinPayload: Record<string, unknown>,
  state: CompanionWatchState,
  now = new Date()
): { output: Record<string, never>; nextState: CompanionWatchState } {
  const receipt = extractWorkReceipt(
    stdinPayload.tool_name,
    stdinPayload.tool_input,
    stdinPayload.result_json
  );
  if (!receipt) return { output: {}, nextState: state };
  const conversationId =
    typeof stdinPayload.conversation_id === "string"
      ? stdinPayload.conversation_id
      : typeof stdinPayload.session_id === "string"
        ? stdinPayload.session_id
        : undefined;
  return {
    output: {},
    nextState: upsertWatch(state, {
      ...receipt,
      createdAt: now.toISOString(),
      conversationId
    })
  };
}

export async function handleStop(
  stdinPayload: Record<string, unknown>,
  state: CompanionWatchState,
  options: {
    now?: Date | (() => Date);
    hookTimeoutMs?: number;
    envWaitSec?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<{ output: { followup_message?: string }; nextState: CompanionWatchState }> {
  const decided = await decideStopFollowup(state, {
    hookStatus: typeof stdinPayload.status === "string" ? stdinPayload.status : undefined,
    now: options.now,
    hookTimeoutMs: options.hookTimeoutMs,
    envWaitSec: options.envWaitSec,
    sleep: options.sleep
  });
  return {
    output: decided.followup ? { followup_message: decided.followup } : {},
    nextState: decided.nextState
  };
}
