import fs from "node:fs";
import path from "node:path";
import {
  buildJobId,
  isActiveJobStatus,
  nowIso,
  type JobKind,
  type JobRecord
} from "./jobs.js";

const DEFAULT_MAX_JOBS = 100;

interface JobState {
  jobs: string[];
}

interface ReadJobOptions {
  skipMalformed?: boolean;
}

export interface JobPaths {
  jobFile: string;
  logFile: string;
  eventsFile: string;
}

export interface CreateJobInput {
  kind: JobKind;
  workflow?: string;
  task: string;
  request: unknown;
  parentJobId?: string | null;
}

export interface JobStoreOptions {
  maxJobs?: number;
}

export type JobUpdatePatch = Partial<Omit<JobRecord, "id" | "kind" | "cwd" | "createdAt">>;

export function resolveJobDir(cwd: string): string {
  return path.join(cwd, ".codex-mimo", "jobs");
}

export function resolveJobStateFile(cwd: string): string {
  return path.join(resolveJobDir(cwd), "state.json");
}

export function resolveJobPaths(cwd: string, jobId: string): JobPaths {
  assertValidJobId(jobId);
  const jobDir = resolveJobDir(cwd);
  return {
    jobFile: path.join(jobDir, `${jobId}.json`),
    logFile: path.join(jobDir, `${jobId}.log`),
    eventsFile: path.join(jobDir, `${jobId}.events.jsonl`)
  };
}

export function createJobStore(cwd: string, options: JobStoreOptions = {}): {
  create(input: CreateJobInput): JobRecord;
} {
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;

  return {
    create(input: CreateJobInput): JobRecord {
      ensureJobDir(cwd);

      const id = buildJobId(input.kind);
      const paths = resolveJobPaths(cwd, id);
      const timestamp = nowIso();
      const record: JobRecord = {
        id,
        kind: input.kind,
        workflow: input.workflow,
        cwd,
        task: input.task,
        request: input.request,
        status: "queued",
        phase: "queued",
        pid: null,
        sessionId: null,
        parentJobId: input.parentJobId ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
        changedFiles: [],
        verification: [],
        logFile: paths.logFile,
        eventsFile: paths.eventsFile
      };

      writeJobRecord(cwd, record);
      const state = readState(cwd);
      state.jobs = [id, ...state.jobs.filter((jobId) => jobId !== id)];
      writeState(cwd, pruneState(cwd, state, maxJobs));

      return record;
    }
  };
}

export function listJobs(cwd: string): JobRecord[] {
  failStaleJobs(cwd);
  return readState(cwd)
    .jobs.map((jobId) => readJobFile(cwd, jobId, { skipMalformed: true }))
    .filter((job): job is JobRecord => job !== undefined);
}

export function readJob(cwd: string, jobId: string): JobRecord | undefined {
  return readJobFile(cwd, jobId);
}

function readJobFile(cwd: string, jobId: string, options: ReadJobOptions = {}): JobRecord | undefined {
  const paths = resolveJobPaths(cwd, jobId);
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(paths.jobFile, "utf-8");
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    if (options.skipMalformed) {
      return undefined;
    }
    throw new Error(`Malformed job file for job id: ${jobId}`, {
      cause: error
    });
  }
  if (!isJobRecord(parsed, jobId)) {
    if (options.skipMalformed) {
      return undefined;
    }
    throw new Error(`Malformed job file for job id: ${jobId}`);
  }
  return parsed;
}

export function updateJob(
  cwd: string,
  jobId: string,
  patch: JobUpdatePatch,
  options: JobStoreOptions = {}
): JobRecord {
  const existing = readJob(cwd, jobId);
  if (!existing) {
    throw new Error(`Job not found: ${jobId}`);
  }

  const updated: JobRecord = {
    ...existing,
    ...patch,
    id: existing.id,
    kind: existing.kind,
    cwd: existing.cwd,
    createdAt: existing.createdAt,
    updatedAt: nowIso()
  };

  writeJobRecord(cwd, updated);
  const state = readState(cwd);
  state.jobs = [jobId, ...state.jobs.filter((id) => id !== jobId)];
  writeState(cwd, pruneState(cwd, state, options.maxJobs ?? DEFAULT_MAX_JOBS));

  return updated;
}

function assertValidJobId(jobId: string): void {
  if (!isValidJobId(jobId)) {
    throw new Error(`Invalid job id: ${jobId}`);
  }
}

function isValidJobId(jobId: string): boolean {
  return jobId !== "state" && /^[a-zA-Z0-9_-]+$/.test(jobId);
}

function isJobRecord(value: unknown, expectedJobId: string): value is JobRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    value.id === expectedJobId &&
    isValidJobId(value.id) &&
    typeof value.kind === "string" &&
    typeof value.cwd === "string" &&
    typeof value.task === "string" &&
    typeof value.status === "string" &&
    typeof value.phase === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.changedFiles) &&
    Array.isArray(value.verification) &&
    typeof value.logFile === "string" &&
    typeof value.eventsFile === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureJobDir(cwd: string): void {
  fs.mkdirSync(resolveJobDir(cwd), { recursive: true });
}

function readState(cwd: string): JobState {
  try {
    const raw = fs.readFileSync(resolveJobStateFile(cwd), "utf-8");
    const state = JSON.parse(raw) as JobState;
    if (
      !Array.isArray(state.jobs) ||
      !state.jobs.every((jobId) => typeof jobId === "string" && isValidJobId(jobId))
    ) {
      return rebuildState(cwd);
    }
    return state;
  } catch {
    return rebuildState(cwd);
  }
}

function writeState(cwd: string, state: JobState): void {
  ensureJobDir(cwd);
  fs.writeFileSync(resolveJobStateFile(cwd), JSON.stringify(state, null, 2), "utf-8");
}

function writeJobRecord(cwd: string, record: JobRecord): void {
  ensureJobDir(cwd);
  fs.writeFileSync(resolveJobPaths(cwd, record.id).jobFile, JSON.stringify(record, null, 2), "utf-8");
}

function pruneState(cwd: string, state: JobState, maxJobs: number): JobState {
  const records = state.jobs
    .map((jobId) => readJobFile(cwd, jobId, { skipMalformed: true }))
    .filter((job): job is JobRecord => job !== undefined);
  const terminal = records.filter((job) => !isActiveJobStatus(job.status));
  const activeCount = records.length - terminal.length;
  const terminalSlots = Math.max(0, maxJobs - activeCount);
  const terminalIds = new Set(terminal.slice(0, terminalSlots).map((job) => job.id));
  const kept = records.filter((job) => isActiveJobStatus(job.status) || terminalIds.has(job.id));

  for (const job of terminal.slice(terminalSlots)) {
    const paths = resolveJobPaths(cwd, job.id);
    fs.rmSync(paths.jobFile, { force: true });
    fs.rmSync(paths.logFile, { force: true });
    fs.rmSync(paths.eventsFile, { force: true });
  }
  return { jobs: kept.map((job) => job.id) };
}

function rebuildState(cwd: string): JobState {
  const jobDir = resolveJobDir(cwd);
  let entries: string[];
  try {
    entries = fs.readdirSync(jobDir);
  } catch (error) {
    if (isMissingFileError(error)) {
      return { jobs: [] };
    }
    throw error;
  }

  const jobs = entries
    .filter((entry) => entry.endsWith(".json") && entry !== "state.json")
    .map((entry) => entry.slice(0, -".json".length))
    .filter((jobId) => isValidJobId(jobId))
    .map((jobId) => readJobFile(cwd, jobId, { skipMalformed: true }))
    .filter((job): job is JobRecord => job !== undefined)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((job) => job.id);

  return { jobs };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

const DEFAULT_STALE_THRESHOLD_MS = 300_000;

export function failStaleJobs(
  cwd: string,
  options: { staleThresholdMs?: number } = {}
): JobRecord[] {
  const threshold = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const cutoff = Date.now() - threshold;
  const jobs = readState(cwd)
    .jobs.map((jobId) => readJobFile(cwd, jobId, { skipMalformed: true }))
    .filter((job): job is JobRecord => job !== undefined);
  const failed: JobRecord[] = [];

  for (const job of jobs) {
    if (job.status !== "queued") continue;
    const createdAt = new Date(job.createdAt).getTime();
    if (createdAt >= cutoff) continue;

    const updated = updateJob(cwd, job.id, {
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt: nowIso(),
      errorCode: "stale_queued",
      error: `Job stuck in queued state for longer than ${Math.round(threshold / 1000)}s. Worker process may have failed to start.`
    });
    failed.push(updated);
  }

  return failed;
}
