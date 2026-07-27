import fs from "node:fs";
import path from "node:path";
import type { JobPhase, JobStatus } from "./jobs.js";
import { publicProgressSummary } from "./public-summary.js";

export type JobSignalLevel = "debug" | "info" | "warn" | "error";

export type JobSignalKind =
  | "phase_changed"
  | "milestone"
  | "needs_input"
  | "blocked"
  | "stalled"
  | "verification_started"
  | "verification_finished"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export const ATTENTION_SIGNAL_KINDS = [
  "needs_input",
  "blocked",
  "stalled",
  "completed",
  "failed",
  "cancelled",
  "timeout"
] as const satisfies readonly JobSignalKind[];

export type AttentionSignalKind = typeof ATTENTION_SIGNAL_KINDS[number];

export interface JobSignal {
  cursor: number;
  jobId: string;
  kind: JobSignalKind;
  level: JobSignalLevel;
  createdAt: string;
  phase?: JobPhase;
  status?: JobStatus;
  summary: string;
  reportPaths?: {
    json?: string;
    markdown?: string;
    eventsJsonl?: string;
    diff?: string;
  };
}

export type NewJobSignal = Omit<JobSignal, "cursor" | "createdAt"> & {
  createdAt?: string;
  errorCode?: string;
};
export interface ReadJobSignalsOptions {
  sinceCursor?: number;
  limit?: number;
  minLevel?: JobSignalLevel;
}

export interface JobSignalReadResult {
  signals: JobSignal[];
  nextCursor: number;
}

const LEVEL_RANK: Record<JobSignalLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

export function isAttentionSignal(
  signal: JobSignalKind | Pick<JobSignal, "kind">
): boolean {
  const kind = typeof signal === "string" ? signal : signal.kind;
  return (ATTENTION_SIGNAL_KINDS as readonly JobSignalKind[]).includes(kind);
}

export interface ReadJobSignalPageOptions extends ReadJobSignalsOptions {
  include?: (signal: JobSignal) => boolean;
}

export function appendJobSignal(file: string, signal: NewJobSignal): JobSignal {
  const cursor = readJobSignals(file).nextCursor + 1;
  return appendJobSignalAtCursor(file, cursor, signal);
}

export function appendJobSignalAtCursor(
  file: string,
  cursor: number,
  signal: NewJobSignal
): JobSignal {
  const { errorCode, ...publicSignal } = signal;
  const stored: JobSignal = {
    ...publicSignal,
    summary: publicProgressSummary({
      type: "signal",
      kind: signal.kind,
      status: signal.status,
      phase: signal.phase,
      ...(errorCode !== undefined ? { errorCode } : {})
    }),
    cursor,
    createdAt: signal.createdAt ?? new Date().toISOString()
  };
  const current = readJobSignals(file);
  const existing = current.signals.find((candidate) => candidate.cursor === cursor);
  if (existing) {
    if (sameSignal(existing, stored)) return existing;
    throw new Error(`Job signal cursor conflict: ${cursor}`);
  }
  if (cursor !== current.nextCursor + 1) {
    throw new Error(`Job signal cursor must be ${current.nextCursor + 1}, received ${cursor}`);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  ensureLineBoundary(file);
  fs.appendFileSync(file, `${JSON.stringify(stored)}\n`, "utf8");
  return stored;
}

export function readJobSignals(file: string, options: ReadJobSignalsOptions = {}): JobSignalReadResult {
  if (!fs.existsSync(file)) return { signals: [], nextCursor: 0 };

  const minRank = LEVEL_RANK[options.minLevel ?? "debug"];
  const sinceCursor = options.sinceCursor ?? 0;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const signals: JobSignal[] = [];
  let nextCursor = 0;

  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const parsed = parseJobSignalLine(line);
    if (!parsed) continue;
    nextCursor = Math.max(nextCursor, parsed.cursor);
    if (parsed.cursor <= sinceCursor) continue;
    if (LEVEL_RANK[parsed.level] < minRank) continue;
    signals.push(parsed);
  }

  return { signals: signals.slice(0, limit), nextCursor };
}

function parseJobSignalLine(line: string): JobSignal | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const value = JSON.parse(trimmed) as Partial<JobSignal>;
    if (!isJobSignal(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function isJobSignal(value: Partial<JobSignal>): value is JobSignal {
  return (
    typeof value.cursor === "number" &&
    Number.isInteger(value.cursor) &&
    value.cursor > 0 &&
    typeof value.jobId === "string" &&
    typeof value.kind === "string" &&
    typeof value.level === "string" &&
    value.level in LEVEL_RANK &&
    typeof value.createdAt === "string" &&
    typeof value.summary === "string"
  );
}

export function readJobSignalPage(
  file: string,
  options: ReadJobSignalPageOptions = {}
): JobSignalReadResult {
  const sinceCursor = options.sinceCursor ?? 0;
  if (!fs.existsSync(file)) return { signals: [], nextCursor: sinceCursor };

  const minRank = LEVEL_RANK[options.minLevel ?? "debug"];
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const include = options.include ?? (() => true);
  const signals: JobSignal[] = [];
  let nextCursor = sinceCursor;

  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const parsed = parseJobSignalLine(line);
    if (!parsed || parsed.cursor <= sinceCursor) continue;
    if (LEVEL_RANK[parsed.level] < minRank || !include(parsed)) {
      nextCursor = Math.max(nextCursor, parsed.cursor);
      continue;
    }
    if (signals.length >= limit) break;
    signals.push(parsed);
    nextCursor = Math.max(nextCursor, parsed.cursor);
  }

  return { signals, nextCursor };
}

function sameSignal(left: JobSignal, right: JobSignal): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ensureLineBoundary(file: string): void {
  try {
    const contents = fs.readFileSync(file);
    if (contents.length > 0 && contents[contents.length - 1] !== 0x0a) {
      fs.appendFileSync(file, "\n", "utf8");
    }
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}
