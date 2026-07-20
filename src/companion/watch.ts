import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const WORK_TOOLS = new Set([
  "mimo_plan",
  "mimo_implement",
  "mimo_review",
  "mimo_fix_ci",
  "mimo_resume",
  "mimo_compose"
]);

export const ATTENTION_STATUSES = new Set([
  "needs_input",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "timeout"
]);

export const ACTIVE_STATUSES = new Set(["queued", "running"]);

export interface CompanionWatch {
  cwd: string;
  jobId: string;
  kind?: string;
  createdAt: string;
  conversationId?: string;
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

export function decideStopFollowup(
  state: CompanionWatchState,
  options: {
    now?: Date;
    loopCount?: number;
    maxActiveLoops?: number;
    hookStatus?: string;
  } = {}
): StopDecision {
  const now = options.now ?? new Date();
  const loopCount = typeof options.loopCount === "number" && Number.isFinite(options.loopCount)
    ? options.loopCount
    : 0;
  const maxActiveLoops = typeof options.maxActiveLoops === "number" && Number.isFinite(options.maxActiveLoops)
    ? options.maxActiveLoops
    : 8;
  const status = options.hookStatus ?? "completed";
  if (status === "aborted") {
    return { followup: undefined, nextState: state };
  }

  const next: CompanionWatchState = {
    version: 1,
    watches: [...state.watches],
    acked: { ...state.acked }
  };

  const stillWatching: CompanionWatch[] = [];
  const attentionHits: Array<CompanionWatch & { job: { status: string; updatedAt?: string } }> = [];
  const activeHits: Array<CompanionWatch & { job: { status: string; updatedAt?: string } }> = [];

  for (const watch of next.watches) {
    const job = readJobRecord(watch.cwd, watch.jobId);
    if (!job || typeof job.status !== "string") continue;
    const key = watchKey(watch.cwd, watch.jobId);
    if (ATTENTION_STATUSES.has(job.status)) {
      // Enhancement 1: same attention status must not re-trigger follow-up.
      if (next.acked[key]?.status === job.status) continue;
      attentionHits.push({ ...watch, job: { status: job.status, updatedAt: job.updatedAt } });
      continue;
    }
    if (ACTIVE_STATUSES.has(job.status)) {
      activeHits.push({ ...watch, job: { status: job.status, updatedAt: job.updatedAt } });
      stillWatching.push(watch);
    }
  }

  if (attentionHits.length > 0) {
    const hit = attentionHits[0]!;
    const key = watchKey(hit.cwd, hit.jobId);
    next.acked[key] = { status: hit.job.status, ackedAt: now.toISOString() };
    next.watches = [
      ...attentionHits.slice(1).map(({ job: _job, ...watch }) => watch),
      ...activeHits.map(({ job: _job, ...watch }) => watch)
    ];
    const cwdLiteral = JSON.stringify(hit.cwd);
    const jobIdLiteral = JSON.stringify(hit.jobId);
    return {
      followup: [
        `MiMoCode job ${hit.jobId} now requires attention (status=${hit.job.status}).`,
        `In cwd ${hit.cwd}, call the MCP tool mimo_result with {"cwd":${cwdLiteral},"jobId":${jobIdLiteral}}.`,
        "Summarize the result for the user. Do not invent outcomes. If status is needs_input or blocked, ask the user what to send via mimo_resume."
      ].join(" "),
      nextState: next
    };
  }

  next.watches = stillWatching;
  if (activeHits.length > 0 && loopCount < maxActiveLoops) {
    const hit = activeHits[0]!;
    const cwdLiteral = JSON.stringify(hit.cwd);
    const jobIdLiteral = JSON.stringify(hit.jobId);
    return {
      followup: [
        `MiMoCode job ${hit.jobId} is still ${hit.job.status}.`,
        `Call mimo_status with {"cwd":${cwdLiteral},"jobId":${jobIdLiteral}} (or one diagnostic mimo_wait).`,
        "If it is still queued/running, stop after the tool result so the companion can check again.",
        "Do not invent completion. Do not ask the user to poll manually."
      ].join(" "),
      nextState: next
    };
  }

  return { followup: undefined, nextState: next };
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

export function handleStop(
  stdinPayload: Record<string, unknown>,
  state: CompanionWatchState,
  options: { maxActiveLoops?: number; now?: Date } = {}
): { output: { followup_message?: string }; nextState: CompanionWatchState } {
  const loopCount = typeof stdinPayload.loop_count === "number" && Number.isFinite(stdinPayload.loop_count)
    ? stdinPayload.loop_count
    : 0;
  const decided = decideStopFollowup(state, {
    loopCount,
    hookStatus: typeof stdinPayload.status === "string" ? stdinPayload.status : undefined,
    maxActiveLoops: options.maxActiveLoops,
    now: options.now
  });
  return {
    output: decided.followup ? { followup_message: decided.followup } : {},
    nextState: decided.nextState
  };
}
