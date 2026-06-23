import fs from "node:fs";
import path from "node:path";
import {
  buildJobId,
  nowIso,
  type JobKind,
  type JobRecord
} from "./jobs.js";

const DEFAULT_MAX_JOBS = 100;

interface JobState {
  jobs: string[];
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
  return readState(cwd)
    .jobs.map((jobId) => readJob(cwd, jobId))
    .filter((job): job is JobRecord => job !== undefined);
}

export function readJob(cwd: string, jobId: string): JobRecord | undefined {
  try {
    const raw = fs.readFileSync(resolveJobPaths(cwd, jobId).jobFile, "utf-8");
    return JSON.parse(raw) as JobRecord;
  } catch {
    return undefined;
  }
}

export function updateJob(cwd: string, jobId: string, patch: JobUpdatePatch): JobRecord {
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
  writeState(cwd, pruneState(cwd, state, DEFAULT_MAX_JOBS));

  return updated;
}

function ensureJobDir(cwd: string): void {
  fs.mkdirSync(resolveJobDir(cwd), { recursive: true });
}

function readState(cwd: string): JobState {
  try {
    const raw = fs.readFileSync(resolveJobStateFile(cwd), "utf-8");
    return JSON.parse(raw) as JobState;
  } catch {
    return { jobs: [] };
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
  const kept = state.jobs.slice(0, maxJobs);
  for (const jobId of state.jobs.slice(maxJobs)) {
    const paths = resolveJobPaths(cwd, jobId);
    fs.rmSync(paths.jobFile, { force: true });
    fs.rmSync(paths.logFile, { force: true });
    fs.rmSync(paths.eventsFile, { force: true });
  }
  return { jobs: kept };
}
