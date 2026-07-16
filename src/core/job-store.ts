import fs from "node:fs";
import path from "node:path";
import {
  buildJobId,
  isActiveJobStatus,
  nowIso,
  type JobKind,
  type JobRecord,
  type PendingJobTransition
} from "./jobs.js";
import type { NotificationTarget } from "../notify/types.js";

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
  signalsFile: string;
  notificationOutboxFile: string;
}

export interface CreateJobInput {
  kind: JobKind;
  task: string;
  request: unknown;
  parentJobId?: string | null;
  notificationTarget?: NotificationTarget;
}

export interface JobStoreOptions {
  maxJobs?: number;
}

export type JobUpdatePatch = Partial<Omit<
  JobRecord,
  "id" | "kind" | "cwd" | "createdAt" | "pendingTransition"
>>;

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
    eventsFile: path.join(jobDir, `${jobId}.events.jsonl`),
    signalsFile: path.join(jobDir, `${jobId}.signals.jsonl`),
    notificationOutboxFile: path.join(jobDir, "notifications.jsonl")
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
        cwd,
        task: input.task,
        request: input.request,
        status: "queued",
        pid: null,
        sessionId: null,
        parentJobId: input.parentJobId ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
        changedFiles: [],
        verification: [],
        notificationTarget: input.notificationTarget,
        logFile: paths.logFile,
        eventsFile: paths.eventsFile,
        signalsFile: paths.signalsFile,
        notificationOutboxFile: paths.notificationOutboxFile
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
  if (Object.prototype.hasOwnProperty.call(patch, "phase") && patch.phase === undefined) {
    delete updated.phase;
  }

  writeJobRecord(cwd, updated);
  const state = readState(cwd);
  state.jobs = [jobId, ...state.jobs.filter((id) => id !== jobId)];
  writeState(cwd, pruneState(cwd, state, options.maxJobs ?? DEFAULT_MAX_JOBS));

  return updated;
}

export function savePendingJobTransition(
  cwd: string,
  jobId: string,
  pendingTransition: PendingJobTransition
): JobRecord {
  const existing = readJob(cwd, jobId);
  if (!existing) throw new Error(`Job not found: ${jobId}`);
  if (existing.pendingTransition) {
    if (samePendingTransition(existing.pendingTransition, pendingTransition)) return existing;
    throw new Error(`Job already has a pending transition: ${jobId}`);
  }
  if (existing.status !== pendingTransition.fromStatus) {
    throw new Error(
      `Pending transition expected ${pendingTransition.fromStatus}, found ${existing.status}`
    );
  }

  return writeUpdatedJob(cwd, {
    ...existing,
    pendingTransition,
    updatedAt: nowIso()
  });
}

export function finalizePendingJobTransition(
  cwd: string,
  jobId: string,
  pendingTransition: PendingJobTransition
): JobRecord {
  const existing = readJob(cwd, jobId);
  if (!existing) throw new Error(`Job not found: ${jobId}`);
  if (!existing.pendingTransition ||
      !samePendingTransition(existing.pendingTransition, pendingTransition)) {
    throw new Error(`Pending transition changed before final commit: ${jobId}`);
  }
  if (existing.status !== pendingTransition.fromStatus) {
    throw new Error(
      `Pending transition expected ${pendingTransition.fromStatus}, found ${existing.status}`
    );
  }

  const updated: JobRecord = {
    ...existing,
    ...transitionRecordPatch(pendingTransition),
    pendingTransition: {
      ...pendingTransition,
      stage: "finalized"
    },
    updatedAt: nowIso()
  };
  if (pendingTransition.phase === undefined) delete updated.phase;
  return writeUpdatedJob(cwd, updated);
}

export function clearPendingJobTransition(
  cwd: string,
  jobId: string,
  pendingTransition: PendingJobTransition
): JobRecord {
  const existing = readJob(cwd, jobId);
  if (!existing) throw new Error(`Job not found: ${jobId}`);
  const finalized = { ...pendingTransition, stage: "finalized" as const };
  if (!existing.pendingTransition ||
      !samePendingTransition(existing.pendingTransition, finalized)) {
    throw new Error(`Pending transition changed before clear: ${jobId}`);
  }
  if (existing.status !== pendingTransition.status) {
    throw new Error(
      `Finalized transition expected ${pendingTransition.status}, found ${existing.status}`
    );
  }

  const updated = { ...existing, updatedAt: nowIso() };
  delete updated.pendingTransition;
  return writeUpdatedJob(cwd, updated);
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
    (value.phase === undefined || typeof value.phase === "string") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.changedFiles) &&
    Array.isArray(value.verification) &&
    isOptionalExecutionCallback(value.executionCallback) &&
    typeof value.logFile === "string" &&
    typeof value.eventsFile === "string" &&
    typeof value.signalsFile === "string" &&
    typeof value.notificationOutboxFile === "string" &&
    (value.pendingTransition === undefined ||
      (isJobStatus(value.status) && isPendingJobTransition(value.pendingTransition, value.status)))
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
  const jobFile = resolveJobPaths(cwd, record.id).jobFile;
  const temporary = `${jobFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2), "utf-8");
    fs.renameSync(temporary, jobFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeUpdatedJob(cwd: string, record: JobRecord): JobRecord {
  writeJobRecord(cwd, record);
  try {
    const state = readState(cwd);
    state.jobs = [record.id, ...state.jobs.filter((id) => id !== record.id)];
    writeState(cwd, pruneState(cwd, state, DEFAULT_MAX_JOBS));
  } catch {
    // The per-job record is authoritative; the auxiliary index can be rebuilt later.
  }
  return record;
}

function samePendingTransition(
  left: PendingJobTransition,
  right: PendingJobTransition
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function transitionRecordPatch(
  transition: PendingJobTransition
): JobUpdatePatch {
  return {
    status: transition.status,
    summary: transition.summary,
    phase: transition.phase,
    pid: transition.pid,
    ...(transition.startedAt !== undefined ? { startedAt: transition.startedAt } : {}),
    ...(transition.completedAt !== undefined ? { completedAt: transition.completedAt } : {}),
    ...(transition.sessionId !== undefined ? { sessionId: transition.sessionId } : {}),
    ...(transition.changedFiles !== undefined ? { changedFiles: transition.changedFiles } : {}),
    ...(transition.verification !== undefined ? { verification: transition.verification } : {}),
    ...(transition.executionCallback !== undefined
      ? { executionCallback: transition.executionCallback }
      : {}),
    ...(transition.reportPaths !== undefined ? { reportPaths: transition.reportPaths } : {}),
    ...(transition.error !== undefined ? { error: transition.error } : {}),
    ...(transition.errorCode !== undefined ? { errorCode: transition.errorCode } : {})
  };
}

const JOB_STATUSES = new Set([
  "queued",
  "running",
  "needs_input",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "timeout"
]);

const JOB_PHASES = new Set([
  "starting",
  "planning",
  "investigating",
  "editing",
  "verifying",
  "reviewing",
  "finalizing"
]);

const LEGAL_TRANSITIONS: Record<string, readonly string[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["needs_input", "blocked", "completed", "failed", "cancelled", "timeout"],
  needs_input: [],
  blocked: [],
  completed: [],
  failed: [],
  cancelled: [],
  timeout: []
};

function isJobStatus(value: unknown): value is JobRecord["status"] {
  return typeof value === "string" && JOB_STATUSES.has(value);
}

function isJobPhase(value: unknown): value is NonNullable<JobRecord["phase"]> {
  return typeof value === "string" && JOB_PHASES.has(value);
}

function isPendingJobTransition(
  value: unknown,
  recordStatus: JobRecord["status"]
): value is PendingJobTransition {
  if (!isRecord(value) ||
      value.version !== 1 ||
      (value.stage !== "prepared" && value.stage !== "finalized") ||
      !isJobStatus(value.fromStatus) ||
      !isJobStatus(value.status) ||
      !LEGAL_TRANSITIONS[value.fromStatus].includes(value.status) ||
      typeof value.summary !== "string" ||
      !Number.isInteger(value.signalCursor) ||
      (value.signalCursor as number) <= 0 ||
      !isTimestamp(value.signalCreatedAt) ||
      typeof value.requestHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.requestHash) ||
      (value.stage === "prepared" && recordStatus !== value.fromStatus) ||
      (value.stage === "finalized" && recordStatus !== value.status) ||
      !isNormalizedTransitionState(value) ||
      !isOptionalTimestamp(value.startedAt) ||
      !isOptionalTimestamp(value.completedAt) ||
      !isOptionalNullableString(value.sessionId) ||
      !isOptionalStringArray(value.changedFiles) ||
      !isOptionalVerificationArray(value.verification) ||
      !isOptionalExecutionCallback(value.executionCallback) ||
      !isOptionalReportPaths(value.reportPaths) ||
      !isOptionalString(value.error) ||
      !isOptionalString(value.errorCode)) {
    return false;
  }

  return value.status === "running"
    ? isTimestamp(value.startedAt) && value.completedAt === undefined
    : isTimestamp(value.completedAt) && value.startedAt === undefined;
}

function isNormalizedTransitionState(value: Record<string, unknown>): boolean {
  if (value.status === "running") {
    return (value.phase === undefined || isJobPhase(value.phase)) &&
      (value.pid === null || isPositiveInteger(value.pid));
  }
  return value.phase === undefined && value.pid === null;
}

function isOptionalVerificationArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((entry) =>
    isRecord(entry) &&
    typeof entry.command === "string" &&
    (entry.exitCode === null || Number.isInteger(entry.exitCode)) &&
    typeof entry.passed === "boolean" &&
    (entry.durationMs === undefined ||
      (typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs) &&
        entry.durationMs >= 0))
  ));
}

function isOptionalExecutionCallback(value: unknown): boolean {
  if (value === undefined) return true;
  return isRecord(value) &&
    Object.keys(value).every((key) => EXECUTION_CALLBACK_KEYS.has(key)) &&
    typeof value.invocationId === "string" &&
    (value.outcome === "completed" || value.outcome === "error" ||
      value.outcome === "cancelled" || value.outcome === "missing") &&
    isOptionalNullableString(value.sessionId) &&
    isOptionalTimestamp(value.receivedAt) &&
    isOptionalString(value.error);
}

const EXECUTION_CALLBACK_KEYS = new Set([
  "invocationId",
  "outcome",
  "sessionId",
  "receivedAt",
  "error"
]);

function isOptionalReportPaths(value: unknown): boolean {
  if (value === undefined) return true;
  return isRecord(value) &&
    isOptionalString(value.json) &&
    isOptionalString(value.markdown) &&
    isOptionalString(value.eventsJsonl) &&
    isOptionalString(value.diff);
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isTimestamp(value);
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
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
    fs.rmSync(paths.signalsFile, { force: true });
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
      phase: undefined,
      pid: null,
      completedAt: nowIso(),
      errorCode: "stale_queued",
      error: `Job stuck in queued state for longer than ${Math.round(threshold / 1000)}s. Worker process may have failed to start.`
    });
    failed.push(updated);
  }

  return failed;
}
