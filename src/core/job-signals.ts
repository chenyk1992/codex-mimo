import fs from "node:fs";
import path from "node:path";
import type { JobPhase, JobStatus } from "./jobs.js";

export type JobSignalLevel = "debug" | "info" | "warn" | "error";

export type JobSignalKind =
  | "phase_changed"
  | "milestone"
  | "needs_input"
  | "blocked"
  | "verification_started"
  | "verification_finished"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

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

export function appendJobSignal(file: string, signal: NewJobSignal): JobSignal {
  const cursor = readJobSignals(file).nextCursor + 1;
  const stored: JobSignal = {
    ...signal,
    cursor,
    createdAt: signal.createdAt ?? new Date().toISOString()
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
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
