import { createHash } from "node:crypto";
import {
  appendJobSignal,
  appendJobSignalAtCursor,
  isAttentionSignal,
  readJobSignals,
  type AttentionSignalKind,
  type JobSignal,
  type JobSignalKind,
  type JobSignalLevel,
  type NewJobSignal
} from "./job-signals.js";
import {
  clearPendingJobTransition,
  finalizePendingJobTransition,
  readJob,
  resolveJobPaths,
  savePendingJobTransition,
  updateJobAuthoritative,
  type JobUpdatePatch
} from "./job-store.js";
import {
  nowIso,
  type EffectiveProgressKind,
  type JobRecord,
  type JobReportPaths,
  type JobStatus,
  type JobTransitionFields,
  type PendingJobTransition
} from "./jobs.js";
import { withProcessLock } from "./process-lock.js";
import {
  enqueueDelivery as enqueueNotificationDelivery,
  readDeliveries
} from "../notify/outbox.js";
import { publicProgressSummary } from "./public-summary.js";
import { readSavedJobOutput } from "./job-output.js";
import {
  writeJobArtifacts,
  type WriteJobArtifactsInput
} from "./job-artifacts.js";

const LEGAL: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["needs_input", "blocked", "stalled", "completed", "failed", "cancelled", "timeout"],
  needs_input: [],
  blocked: [],
  stalled: [],
  completed: [],
  failed: [],
  cancelled: [],
  timeout: []
};

export interface JobTransition extends JobTransitionFields {}

export interface JobTransitionResult {
  job: JobRecord;
  signal: JobSignal;
  deliveryCreated: boolean;
}

export interface JobTransitionDependencies {
  afterIntentPersisted?: () => Promise<void> | void;
  afterSignalAppended?: () => Promise<void> | void;
  afterJobFinalized?: () => Promise<void> | void;
  afterDeliveryEnqueued?: () => Promise<void> | void;
  afterIntentCleared?: () => Promise<void> | void;
  appendSignal?: typeof appendJobSignalAtCursor;
  enqueueDelivery?: typeof enqueueNotificationDelivery;
  writeJobArtifacts?: (input: WriteJobArtifactsInput) => JobReportPaths;
}

type ProgressSignalKind = Exclude<JobSignalKind, AttentionSignalKind>;

export type JobProgress = Omit<NewJobSignal, "jobId" | "kind" | "status"> & {
  kind: ProgressSignalKind;
};

export async function transitionJob(
  cwd: string,
  jobId: string,
  transition: JobTransition,
  dependencies: JobTransitionDependencies = {}
): Promise<JobTransitionResult> {
  return withProcessLock(resolveJobStateLock(cwd, jobId), async () => {
    let existing = requireJob(cwd, jobId);
    if (existing.pendingTransition) {
      const sameRequest = pendingMatchesRequest(existing.pendingTransition, transition);
      const recovered = await applyPendingTransition(
        cwd,
        existing,
        existing.pendingTransition,
        dependencies
      );
      if (sameRequest) return recovered;
      existing = recovered.job;
    }

    if (!LEGAL[existing.status].includes(transition.status)) {
      throw new Error(`Illegal job transition ${existing.status} -> ${transition.status}`);
    }
    if (existing.cancellationRequestedAt && transition.status !== "cancelled") {
      throw new Error(`Job ${jobId} cancellation was requested; only cancellation may finalize it.`);
    }

    const requested = ensureTransitionArtifacts(existing, transition, dependencies);
    const pending = buildPendingTransition(existing, requested, transition);
    const intentJob = await savePendingJobTransition(cwd, jobId, pending);
    await dependencies.afterIntentPersisted?.();
    return applyPendingTransition(cwd, intentJob, pending, dependencies);
  });
}

export async function appendJobProgress(
  cwd: string,
  jobId: string,
  progress: JobProgress
): Promise<JobSignal> {
  if (isAttentionSignal(progress as Pick<JobSignal, "kind">)) {
    throw new Error(`Attention signal ${progress.kind} must be written by transitionJob`);
  }
  return withProcessLock(resolveJobStateLock(cwd, jobId), async () => {
    let job = requireJob(cwd, jobId);
    if (job.pendingTransition) {
      job = (await applyPendingTransition(cwd, job, job.pendingTransition, {})).job;
    }
    return appendJobSignal(job.signalsFile, { ...progress, jobId });
  });
}

export async function updateRunningJobProcess(
  cwd: string,
  jobId: string,
  pid: number | null,
  processIdentity: string | null
): Promise<JobRecord> {
  return withProcessLock(resolveJobStateLock(cwd, jobId), async () => {
    const job = requireJob(cwd, jobId);
    if (job.status !== "running") return job;
    return updateJobAuthoritative(cwd, jobId, { pid, processIdentity });
  });
}

export async function updateRunningJobObservation(
  cwd: string,
  jobId: string,
  patch: {
    lastEventAt?: string;
    lastActivityAt?: string;
    lastProgressAt?: string;
    lastProgressKind?: EffectiveProgressKind;
    lastProgressFingerprint?: string;
    lastTool?: string;
    lastCommand?: string;
    sessionId?: string | null;
    idleTimeoutMs?: number;
    quietSince?: string | null;
  }
): Promise<JobRecord> {
  return withProcessLock(resolveJobStateLock(cwd, jobId), async () => {
    const job = requireJob(cwd, jobId);
    if (job.status !== "running") return job;
    return updateJobAuthoritative(cwd, jobId, patch as JobUpdatePatch);
  });
}

export async function requestJobCancellation(
  cwd: string,
  jobId: string
): Promise<JobRecord> {
  return withProcessLock(resolveJobStateLock(cwd, jobId), async () => {
    let job = requireJob(cwd, jobId);
    if (job.pendingTransition) {
      job = (await applyPendingTransition(cwd, job, job.pendingTransition, {})).job;
    }
    if (job.status !== "queued" && job.status !== "running") return job;
    if (job.cancellationRequestedAt) return job;
    return updateJobAuthoritative(cwd, jobId, { cancellationRequestedAt: nowIso() });
  });
}

export async function recoverPendingTransition(
  cwd: string,
  jobId: string,
  dependencies: JobTransitionDependencies = {}
): Promise<JobTransitionResult | undefined> {
  return withProcessLock(resolveJobStateLock(cwd, jobId), async () => {
    const job = requireJob(cwd, jobId);
    if (!job.pendingTransition) return recoverUnacknowledgedDelivery(job);
    return applyPendingTransition(cwd, job, job.pendingTransition, dependencies);
  });
}

async function applyPendingTransition(
  cwd: string,
  job: JobRecord,
  pending: PendingJobTransition,
  dependencies: JobTransitionDependencies
): Promise<JobTransitionResult> {
  const appendSignal = dependencies.appendSignal ?? appendJobSignalAtCursor;
  const signal = appendSignal(job.signalsFile, pending.signalCursor, {
    jobId: job.id,
    kind: transitionSignalKind(pending.status),
    level: signalLevel(pending.status),
    status: pending.status,
    createdAt: pending.signalCreatedAt,
    ...(pending.phase ? { phase: pending.phase } : {}),
    summary: pending.summary,
    ...(pending.reportPaths ? { reportPaths: pending.reportPaths } : {}),
    ...(pending.errorCode !== undefined ? { errorCode: pending.errorCode } : {})
  });
  await dependencies.afterSignalAppended?.();

  let finalized = job;
  if (pending.stage === "prepared") {
    finalized = await finalizePendingJobTransition(cwd, job.id, pending);
    pending = finalized.pendingTransition!;
    await dependencies.afterJobFinalized?.();
  }

  let deliveryCreated = false;
  if (finalized.notificationTarget && isAttentionSignal(signal)) {
    const enqueueDelivery = dependencies.enqueueDelivery ?? enqueueNotificationDelivery;
    const enqueued = await enqueueDelivery(finalized.notificationOutboxFile, {
      jobId: finalized.id,
      signalCursor: signal.cursor,
      target: finalized.notificationTarget,
      createdAt: signal.createdAt
    });
    deliveryCreated = enqueued.created;
    await dependencies.afterDeliveryEnqueued?.();
  }

  const cleared = await clearPendingJobTransition(cwd, finalized.id, pending);
  await dependencies.afterIntentCleared?.();
  if (!deliveryCreated) {
    const unacked = recoverUnacknowledgedDelivery(cleared);
    if (unacked) return unacked;
  }
  return { job: cleared, signal, deliveryCreated };
}

function recoverUnacknowledgedDelivery(job: JobRecord): JobTransitionResult | undefined {
  const delivery = readDeliveries(job.notificationOutboxFile)
    .filter((candidate) => candidate.jobId === job.id &&
      (candidate.status === "pending" || candidate.status === "delivering"))
    .sort((left, right) => right.signalCursor - left.signalCursor)[0];
  if (!delivery) return undefined;

  const signal = readJobSignals(job.signalsFile).signals.find(
    (candidate) => candidate.cursor === delivery.signalCursor &&
      candidate.status === job.status &&
      candidate.kind === job.status &&
      isAttentionSignal(candidate)
  );
  if (!signal) return undefined;
  return { job, signal, deliveryCreated: true };
}

function buildPendingTransition(
  job: JobRecord,
  transition: JobTransition,
  requestHashSource: JobTransition = transition
): PendingJobTransition {
  const timestamp = nowIso();
  const running = transition.status === "running";
  const publicSummary = publicProgressSummary({
    type: "job",
    status: transition.status,
    phase: running ? transition.phase : undefined,
    ...(transition.errorCode !== undefined ? { errorCode: transition.errorCode } : {})
  });
  return {
    version: 1,
    stage: "prepared",
    fromStatus: job.status,
    signalCursor: readJobSignals(job.signalsFile).nextCursor + 1,
    signalCreatedAt: timestamp,
    requestHash: transitionRequestHash(requestHashSource),
    status: transition.status,
    summary: publicSummary,
    phase: running ? transition.phase : undefined,
    pid: running ? (transition.pid ?? job.pid ?? null) : null,
    processIdentity: running
      ? (transition.processIdentity ?? job.processIdentity ?? null)
      : null,
    ...(running
      ? { startedAt: transition.startedAt ?? job.startedAt ?? timestamp }
      : { completedAt: transition.completedAt ?? timestamp }),
    ...(transition.sessionId !== undefined ? { sessionId: transition.sessionId } : {}),
    ...(transition.changedFiles !== undefined ? { changedFiles: transition.changedFiles } : {}),
    ...(transition.verification !== undefined ? { verification: transition.verification } : {}),
    ...(transition.acceptance !== undefined ? { acceptance: transition.acceptance } : {}),
    ...(transition.executionCallback !== undefined
      ? { executionCallback: sanitizeExecutionCallback(transition.executionCallback) }
      : {}),
    ...(transition.reportPaths !== undefined ? { reportPaths: transition.reportPaths } : {}),
    ...(transition.error !== undefined ? { error: publicSummary } : {}),
    ...(transition.errorCode !== undefined ? { errorCode: transition.errorCode } : {}),
    ...(transition.failureCauses !== undefined ? { failureCauses: transition.failureCauses } : {})
  };
}

function sanitizeExecutionCallback(
  callback: NonNullable<JobTransition["executionCallback"]>
): NonNullable<JobTransition["executionCallback"]> {
  return {
    invocationId: callback.invocationId,
    outcome: callback.outcome,
    ...(callback.sessionId !== undefined ? { sessionId: callback.sessionId } : {}),
    ...(callback.receivedAt !== undefined ? { receivedAt: callback.receivedAt } : {}),
    ...(callback.error !== undefined
      ? { error: publicProgressSummary({ type: "callback", outcome: callback.outcome }) }
      : {})
  };
}

function requireJob(cwd: string, jobId: string): JobRecord {
  const job = readJob(cwd, jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  return job;
}

function pendingMatchesRequest(
  pending: PendingJobTransition,
  transition: JobTransition
): boolean {
  return pending.requestHash === transitionRequestHash(transition);
}

function resolveJobStateLock(cwd: string, jobId: string): string {
  const paths = resolveJobPaths(cwd, jobId);
  return paths.jobFile;
}

function transitionRequestHash(transition: JobTransition): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(transition)), "utf8")
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  );
}

function signalLevel(status: JobStatus): JobSignalLevel {
  if (status === "failed") return "error";
  if (status === "needs_input" || status === "blocked" || status === "stalled" || status === "timeout") {
    return "warn";
  }
  return "info";
}

function transitionSignalKind(status: JobStatus): JobSignalKind {
  if (status === "running") return "phase_changed";
  if (status === "queued") throw new Error("A job cannot transition to queued");
  return status;
}

function ensureTransitionArtifacts(
  job: JobRecord,
  transition: JobTransition,
  dependencies: JobTransitionDependencies
): JobTransition {
  if (transition.status === "running" || transition.reportPaths) return transition;
  const writeArtifacts = dependencies.writeJobArtifacts ?? writeJobArtifacts;
  const workflow = typeof job.request === "object" && job.request !== null
    ? (job.request as Record<string, unknown>).workflow
    : undefined;
  const reportDir = typeof job.request === "object" &&
    job.request !== null &&
    typeof (job.request as Record<string, unknown>).reportDir === "string"
    ? (job.request as Record<string, unknown>).reportDir as string
    : undefined;
  try {
    const reportPaths = writeArtifacts({
      job,
      status: transition.status,
      ...(transition.errorCode ? { errorCode: transition.errorCode } : {}),
      changedFiles: transition.changedFiles ?? job.changedFiles,
      verification: [],
      compactVerification: transition.verification ?? job.verification,
      finalText: readSavedJobOutput(job) ?? "",
      plan: job.kind === "plan" || (job.kind === "compose" && workflow === "plan"),
      ...(reportDir ? { reportDir } : {}),
      existingReportPaths: transition.reportPaths ?? job.reportPaths
    });
    return { ...transition, reportPaths };
  } catch {
    const existingPaths = transition.reportPaths ?? job.reportPaths;
    return existingPaths ? { ...transition, reportPaths: existingPaths } : transition;
  }
}
