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
import { readDeliveries } from "../notify/outbox.js";
import { renameWithWindowsRetry } from "./atomic-file.js";
import { withProcessLock } from "./process-lock.js";
import { readRequestIdleTimeoutMs } from "./job-timeouts.js";

const DEFAULT_MAX_JOBS = 100;

interface ObservedStateRefresh {
  requested: boolean;
  maxJobs: number;
  promise: Promise<void>;
}
const observedStateRefreshes = new Map<string, ObservedStateRefresh>();

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
        processIdentity: null,
        sessionId: null,
        parentJobId: input.parentJobId ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
        changedFiles: [],
        verification: [],
        idleTimeoutMs: readRequestIdleTimeoutMs(input.request),
        notificationTarget: input.notificationTarget,
        logFile: paths.logFile,
        eventsFile: paths.eventsFile,
        signalsFile: paths.signalsFile,
        notificationOutboxFile: paths.notificationOutboxFile
      };

      writeJobRecord(cwd, record);
      pruneRecordsBestEffort(cwd, maxJobs);
      observeStateRefresh(cwd, maxJobs);

      return record;
    }
  };
}

export function listJobs(cwd: string): JobRecord[] {
  const rebuilt = rebuildState(cwd);
  observeStateRefresh(cwd, DEFAULT_MAX_JOBS);
  return rebuilt
    .jobs.map((jobId) => readJobFile(cwd, jobId, { skipMalformed: true }))
    .filter((job): job is JobRecord => job !== undefined);
}

export function listWebhookSecretEnvironmentNames(cwd: string): string[] {
  const targets = [
    ...listJobs(cwd).map((job) => job.notificationTarget),
    ...readDeliveries(path.join(resolveJobDir(cwd), "notifications.jsonl")).map((delivery) => delivery.target)
  ];
  return [...new Set(targets.flatMap((target) =>
    target?.type === "webhook" ? [target.secretEnv] : []
  ))];
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
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
  pruneRecordsBestEffort(cwd, maxJobs);
  observeStateRefresh(cwd, maxJobs);

  return updated;
}

export async function updateJobAuthoritative(
  cwd: string,
  jobId: string,
  patch: JobUpdatePatch,
  options: JobStoreOptions = {}
): Promise<JobRecord> {
  const existing = readJob(cwd, jobId);
  if (!existing) throw new Error(`Job not found: ${jobId}`);

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
  return persistAuthoritativeRecord(cwd, updated, options.maxJobs ?? DEFAULT_MAX_JOBS);
}

export async function savePendingJobTransition(
  cwd: string,
  jobId: string,
  pendingTransition: PendingJobTransition
): Promise<JobRecord> {
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

  return persistAuthoritativeRecord(cwd, {
    ...existing,
    pendingTransition,
    updatedAt: nowIso()
  });
}

export async function finalizePendingJobTransition(
  cwd: string,
  jobId: string,
  pendingTransition: PendingJobTransition
): Promise<JobRecord> {
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
  if (pendingTransition.status !== "running") delete updated.cancellationRequestedAt;
  return persistAuthoritativeRecord(cwd, updated);
}

export async function clearPendingJobTransition(
  cwd: string,
  jobId: string,
  pendingTransition: PendingJobTransition
): Promise<JobRecord> {
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
  return persistAuthoritativeRecord(cwd, updated);
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
    isJobKind(value.kind) &&
    typeof value.cwd === "string" &&
    typeof value.task === "string" &&
    isJobStatus(value.status) &&
    isNormalizedPersistedState(
      value.status,
      value.phase,
      value.pid,
      value.processIdentity
    ) &&
    isCancellationRequestState(value.status, value.cancellationRequestedAt) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.changedFiles) &&
    Array.isArray(value.verification) &&
    isOptionalExecutionCallback(value.executionCallback) &&
    typeof value.logFile === "string" &&
    typeof value.eventsFile === "string" &&
    typeof value.signalsFile === "string" &&
    typeof value.notificationOutboxFile === "string" &&
    isOptionalTimestamp(value.lastEventAt) &&
    isOptionalString(value.lastTool) &&
    isOptionalNonNegativeInteger(value.idleTimeoutMs) &&
    (value.pendingTransition === undefined ||
      (isJobStatus(value.status) && isPendingJobTransition(value.pendingTransition, value.status)))
  );
}

function isPersistedProcessState(
  status: JobRecord["status"],
  pid: unknown,
  processIdentity: unknown
): boolean {
  if (status !== "running") return pid === null && processIdentity === null;
  if (pid === null) return processIdentity === null;
  if (!isPositiveInteger(pid)) return false;
  // Provisional ownership: durable PID before identity capture completes.
  if (processIdentity === null) return true;
  return typeof processIdentity === "string" && processIdentity.trim().length > 0;
}

function isNormalizedPersistedState(
  status: JobRecord["status"],
  phase: unknown,
  pid: unknown,
  processIdentity: unknown
): boolean {
  if (status === "running") {
    return (phase === undefined || isJobPhase(phase)) &&
      isPersistedProcessState(status, pid, processIdentity);
  }
  return phase === undefined && isPersistedProcessState(status, pid, processIdentity);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureJobDir(cwd: string): void {
  fs.mkdirSync(resolveJobDir(cwd), { recursive: true });
}

function writeState(cwd: string, state: JobState): void {
  ensureJobDir(cwd);
  const stateFile = resolveJobStateFile(cwd);
  const temporary = `${stateFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), "utf-8");
    renameWithWindowsRetry(temporary, stateFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeJobRecord(cwd: string, record: JobRecord): void {
  ensureJobDir(cwd);
  const jobFile = resolveJobPaths(cwd, record.id).jobFile;
  const temporary = `${jobFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2), "utf-8");
    renameWithWindowsRetry(temporary, jobFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function persistAuthoritativeRecord(
  cwd: string,
  record: JobRecord,
  maxJobs = DEFAULT_MAX_JOBS
): Promise<JobRecord> {
  writeJobRecord(cwd, record);
  pruneRecordsBestEffort(cwd, maxJobs);
  await refreshStateCacheBestEffort(cwd, maxJobs);
  return record;
}

function observeStateRefresh(cwd: string, maxJobs: number): void {
  const key = resolveJobStateFile(cwd);
  const existing = observedStateRefreshes.get(key);
  if (existing) {
    existing.requested = true;
    existing.maxJobs = maxJobs;
    return;
  }
  const observed = { requested: false, maxJobs, promise: Promise.resolve() };
  observed.promise = (async () => {
    do {
      observed.requested = false;
      await refreshStateCacheBestEffort(cwd, observed.maxJobs);
    } while (observed.requested);
  })().finally(() => {
    if (observedStateRefreshes.get(key) === observed) observedStateRefreshes.delete(key);
  });
  observedStateRefreshes.set(key, observed);
  void observed.promise;
}

async function refreshStateCacheBestEffort(cwd: string, maxJobs: number): Promise<void> {
  try {
    await withProcessLock(resolveJobStateFile(cwd), () => {
      writeState(cwd, pruneState(cwd, rebuildState(cwd), maxJobs));
    }, { timeoutMs: 0 });
  } catch {
    // The atomic per-job record is authoritative; the shared index is rebuildable.
  }
}

function pruneRecordsBestEffort(cwd: string, maxJobs: number): void {
  try {
    pruneState(cwd, rebuildState(cwd), maxJobs);
  } catch {
    // Retention cleanup is auxiliary and must never invalidate an authoritative write.
  }
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
    processIdentity: transition.processIdentity,
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

const JOB_KINDS = new Set([
  "plan",
  "implement",
  "review",
  "fix-ci",
  "resume",
  "compose"
]);

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

function isJobKind(value: unknown): value is JobRecord["kind"] {
  return typeof value === "string" && JOB_KINDS.has(value);
}

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
  return isJobStatus(value.status) && isNormalizedPersistedState(
    value.status,
    value.phase,
    value.pid,
    value.processIdentity
  );
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

function isCancellationRequestState(status: JobRecord["status"], value: unknown): boolean {
  if (value === undefined) return true;
  return (status === "queued" || status === "running") && isTimestamp(value);
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function pruneState(cwd: string, state: JobState, maxJobs: number): JobState {
  const records = state.jobs
    .map((jobId) => readJobFile(cwd, jobId, { skipMalformed: true }))
    .filter((job): job is JobRecord => job !== undefined);
  const unfinishedDeliveryJobIds = new Set(
    readDeliveries(path.join(resolveJobDir(cwd), "notifications.jsonl"))
      .filter((delivery) => delivery.status === "pending" || delivery.status === "delivering")
      .map((delivery) => delivery.jobId)
  );
  const prunable = records.filter((job) => !isRetentionProtectedJob(job, unfinishedDeliveryJobIds));
  const protectedCount = records.length - prunable.length;
  const prunableSlots = Math.max(0, maxJobs - protectedCount);
  const prunableIds = new Set(prunable.slice(0, prunableSlots).map((job) => job.id));
  const kept = records.filter((job) =>
    isRetentionProtectedJob(job, unfinishedDeliveryJobIds) || prunableIds.has(job.id)
  );

  for (const job of prunable.slice(prunableSlots)) {
    const paths = resolveJobPaths(cwd, job.id);
    fs.rmSync(paths.jobFile, { force: true });
    fs.rmSync(paths.logFile, { force: true });
    fs.rmSync(paths.eventsFile, { force: true });
    fs.rmSync(paths.signalsFile, { force: true });
  }
  return { jobs: kept.map((job) => job.id) };
}

function isRetentionProtectedJob(
  job: JobRecord,
  unfinishedDeliveryJobIds: ReadonlySet<string>
): boolean {
  return isActiveJobStatus(job.status) ||
    job.pendingTransition !== undefined ||
    unfinishedDeliveryJobIds.has(job.id);
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
