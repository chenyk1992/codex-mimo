import { execa } from "execa";
import {
  FixCiInput,
  HealthcheckInput,
  ImplementInput,
  JobCancelInput,
  JobEventsInput,
  JobListInput,
  JobResultInput,
  JobStatusInput,
  JobWaitInput,
  PlanInput,
  parseComposeInput,
  ResumeInput,
  ReviewInput
} from "./tool-schemas.js";
import { launchJob, type LaunchJobDependencies } from "../core/job-launcher.js";
import { advanceJobChainAfterChild, bindJobDefinition } from "../core/job-definitions.js";
import {
  captureRepositoryFingerprint,
  detectResumeConflict,
  readJobCheckpoint,
  RESUMABLE_FAILURE_CODES,
  type JobCheckpoint
} from "../core/job-checkpoint.js";
import {
  findChainAttentionSlice,
  isChainOrchestratorRoot,
  isChainSliceChild,
  markPendingSlicesCancelled,
  markSliceRunning,
  markSliceTerminal,
  readJobChain,
  resolveLiveChainChildJobId
} from "../core/job-chain.js";
import { listJobs, readJob, resolveJobPaths, updateJobAuthoritative } from "../core/job-store.js";
import { recoverStaleQueuedJobs } from "../core/job-recovery.js";
import {
  spawnNotificationWorker,
  terminateOwnedJobProcess,
  verifyProcessIdentity,
  type OwnedProcessTermination,
  type ProcessIdentityVerification
} from "../core/job-process.js";
import type { JobNotificationStatus, JobRecord, RenderedJobResult, RenderedJobStatus } from "../core/jobs.js";
import { isSemanticResultJob, renderCompactJobResult, renderCompactJobStatus, renderFullJobResult, renderJobResult, renderJobStatus } from "../core/job-render.js";
import {
  readFinalJobOutput,
  readJobDiagnostics,
  readKeyVerificationError,
  readSavedJobOutput
} from "../core/job-output.js";
import { readRecentJobLogLines } from "../core/job-log.js";
import {
  isAttentionSignal,
  readJobSignalPage,
  type JobSignalReadResult
} from "../core/job-signals.js";
import { requestJobCancellation, transitionJob } from "../core/job-transition.js";
import { ProcessLockUnavailableError, withProcessLock } from "../core/process-lock.js";
import { buildMimoProbeEnvironment, resolveMimoProcessSelection } from "../mimo/run-json.js";
import {
  readNotificationDeliveries,
  summarizeJobNotification
} from "../notify/dispatcher.js";
import type { NotificationDelivery } from "../notify/types.js";
import { startNotificationDispatch } from "../notify/dispatch-process.js";
import { publicProgressSummary } from "../core/public-summary.js";
import { probeCodexCommand } from "../notify/codex-command.js";

const WAIT_CHECK_INTERVAL_MS = 1_000;

export interface MimoHealthcheckDependencies {
  probeCodex?: typeof probeCodexCommand;
}

/** MiMo runtime health plus basic Codex CLI discovery; notified launches preflight their target separately. */
export async function mimoHealthcheck(
  input: unknown,
  deps: MimoHealthcheckDependencies = {}
) {
  const parsed = HealthcheckInput.parse(input);
  const cwd = parsed.cwd ?? process.cwd();
  const probeCodex = deps.probeCodex ?? probeCodexCommand;
  const codexNotification = await probeCodex();
  try {
    const env = buildMimoProbeEnvironment(cwd);
    const selection = resolveMimoProcessSelection(env);
    const result = await execa(selection.command, ["--version"], {
      cwd,
      env
    });
    return { ok: true, version: result.stdout.trim(), cwd, codexNotification };
  } catch {
    return { ok: false, error: "mimo not found or not working", cwd, codexNotification };
  }
}

export async function mimoPlan(input: unknown, deps: LaunchJobDependencies = {}) {
  const parsed = PlanInput.parse(input);
  const { notify, ...request } = parsed;
  return launchJob({ kind: "plan", cwd: parsed.cwd, task: parsed.task, request, notify }, deps);
}

export async function mimoImplement(input: unknown, deps: LaunchJobDependencies = {}) {
  const parsed = ImplementInput.parse(input);
  const { notify, ...request } = parsed;
  return launchJob({ kind: "implement", cwd: parsed.cwd, task: parsed.task, request, notify }, deps);
}

export async function mimoReview(input: unknown, deps: LaunchJobDependencies = {}) {
  const parsed = ReviewInput.parse(input);
  const { notify, ...request } = parsed;
  return launchJob({
    kind: "review",
    cwd: parsed.cwd,
    task: `Review changes since ${parsed.base}.`,
    request,
    notify
  }, deps);
}

export async function mimoFixCi(input: unknown, deps: LaunchJobDependencies = {}) {
  const parsed = FixCiInput.parse(input);
  const { notify, ...request } = parsed;
  return launchJob({
    kind: "fix-ci",
    cwd: parsed.cwd,
    task: parsed.task ?? "Fix the CI failures shown in the attached log.",
    request,
    notify
  }, deps);
}

export async function mimoCompose(input: unknown, deps: LaunchJobDependencies = {}) {
  const parsed = parseComposeInput(input);
  const { notify, ...request } = parsed;
  return launchJob({
    kind: "compose",
    cwd: parsed.cwd,
    task: parsed.task ?? `Run ${parsed.workflow} workflow.`,
    request,
    notify
  }, deps);
}

export interface MimoResumeDependencies extends LaunchJobDependencies {
  verifyProcess?: (
    pid: number,
    expectedIdentity: string | null | undefined
  ) => ProcessIdentityVerification;
  readCheckpoint?: typeof readJobCheckpoint;
  captureFingerprint?: (cwd: string, checkpoint: JobCheckpoint) => Promise<string>;
}

function isResumableParent(parent: JobRecord): boolean {
  if (
    parent.status === "needs_input" ||
    parent.status === "blocked" ||
    parent.status === "stalled" ||
    parent.status === "timeout"
  ) {
    return true;
  }
  return parent.status === "failed" &&
    parent.errorCode !== undefined &&
    RESUMABLE_FAILURE_CODES.has(parent.errorCode);
}

function requiresExplicitTask(parent: JobRecord): boolean {
  return parent.status === "needs_input" || parent.status === "blocked";
}

function requiresCheckpointContext(parent: JobRecord): boolean {
  return parent.status === "stalled" ||
    parent.status === "timeout" ||
    (parent.status === "failed" &&
      parent.errorCode !== undefined &&
      RESUMABLE_FAILURE_CODES.has(parent.errorCode));
}

function assertParentProcessNotAlive(
  parent: JobRecord,
  verify: (
    pid: number,
    expectedIdentity: string | null | undefined
  ) => ProcessIdentityVerification
): void {
  if (typeof parent.pid !== "number" || parent.pid <= 0) return;
  const result = verify(parent.pid, parent.processIdentity);
  if (result.status === "match") {
    throw new Error(`Job ${parent.id} cannot be resumed while its process is still alive.`);
  }
}

export async function mimoResume(input: unknown, deps: MimoResumeDependencies = {}) {
  const parsed = ResumeInput.parse(input);
  const parent = readJob(parsed.cwd, parsed.jobId);
  if (!parent) throw new Error(`No job found for ${parsed.jobId}.`);
  if (!isResumableParent(parent)) {
    throw new Error(`Job ${parent.id} is not in a resumable state.`);
  }
  if (parent.status === "blocked" && parent.errorCode === "stalled_process_alive") {
    throw new Error(`Job ${parent.id} is not resumable while stalled_process_alive.`);
  }
  if (requiresExplicitTask(parent) && !parsed.task?.trim()) {
    throw new Error(`Job ${parent.id} requires a non-empty task before it can be resumed.`);
  }

  const chainResume = resolveChainResumeContext(parsed.cwd, parent);
  const resumeSource = chainResume?.sourceJob ?? parent;

  if (requiresExplicitTask(parent) && !resumeSource.sessionId) {
    throw new Error(`Job ${parent.id} does not have a sessionId and cannot be resumed.`);
  }

  const verify = deps.verifyProcess ?? verifyProcessIdentity;
  assertParentProcessNotAlive(resumeSource, verify);
  if (chainResume && resumeSource.id !== parent.id) {
    assertParentProcessNotAlive(parent, verify);
  }

  const readCheckpoint = deps.readCheckpoint ?? readJobCheckpoint;
  const checkpointPath = parent.reportPaths?.checkpoint ?? resumeSource.reportPaths?.checkpoint;
  let checkpoint = checkpointPath ? readCheckpoint(checkpointPath) : null;
  if (chainResume && checkpoint) {
    checkpoint = {
      ...checkpoint,
      chainId: chainResume.chain.chainId,
      completedSlices: [...chainResume.chain.completedSliceIds],
      ...(chainResume.sliceId ? { sliceId: chainResume.sliceId } : {})
    };
  } else if (chainResume && !checkpoint && resumeSource.reportPaths?.checkpoint) {
    checkpoint = readCheckpoint(resumeSource.reportPaths.checkpoint);
    if (checkpoint) {
      checkpoint = {
        ...checkpoint,
        chainId: chainResume.chain.chainId,
        completedSlices: [...chainResume.chain.completedSliceIds],
        ...(chainResume.sliceId ? { sliceId: chainResume.sliceId } : {})
      };
    }
  }

  if (requiresCheckpointContext(parent) && !checkpoint) {
    throw new Error(`resume_context_missing: Job ${parent.id} has no durable checkpoint.`);
  }
  if (requiresCheckpointContext(parent) && !resumeSource.sessionId && !checkpoint) {
    throw new Error(`resume_context_missing: Job ${parent.id} has no session or checkpoint.`);
  }

  if (checkpoint) {
    const captureFingerprint = deps.captureFingerprint ??
      ((cwd, saved) => captureRepositoryFingerprint(
        cwd,
        [...saved.contextFiles, ...saved.changedFiles]
      ));
    const currentFingerprint = await captureFingerprint(parent.cwd, checkpoint);
    const conflict = detectResumeConflict(checkpoint, { repositoryFingerprint: currentFingerprint });
    if (conflict) {
      throw new Error(`resume_conflict: ${JSON.stringify(conflict)}`);
    }
  }

  const task = parsed.task?.trim() ||
    checkpoint?.remainingChecklist[0] ||
    resumeSource.task ||
    parent.task;
  const executionPolicy = bindJobDefinition(parent).executionPolicy;
  const { notify, ...options } = parsed;
  const request = {
    ...options,
    jobId: parent.id,
    task,
    executionPolicy,
    ...(resumeSource.sessionId ? { sessionId: resumeSource.sessionId } : {}),
    ...(checkpoint ? { checkpoint } : {})
  };

  const receipt = await launchJob({
    kind: "resume",
    cwd: parsed.cwd,
    task,
    parentJobId: chainResume ? chainResume.rootJobId : parent.id,
    ...(chainResume
      ? {
          chainId: chainResume.chain.chainId,
          sliceId: chainResume.sliceId
        }
      : {}),
    request,
    ...(chainResume
      ? { notificationTarget: null }
      : notify === undefined
        ? { notificationTarget: parent.notificationTarget ?? null }
        : { notify })
  }, deps);

  if (chainResume) {
    markSliceRunning(
      parsed.cwd,
      chainResume.chain.chainId,
      chainResume.sliceId,
      receipt.jobId
    );
    await updateJobAuthoritative(parsed.cwd, chainResume.rootJobId, {
      status: "running",
      phase: "editing",
      summary: `Resuming slice ${chainResume.sliceId}.`,
      error: undefined,
      errorCode: undefined,
      pid: null,
      processIdentity: null
    });
  }

  return receipt;
}

function resolveChainResumeContext(
  cwd: string,
  parent: JobRecord
): {
  chain: NonNullable<ReturnType<typeof readJobChain>>;
  sliceId: string;
  rootJobId: string;
  sourceJob: JobRecord;
} | null {
  if (isChainOrchestratorRoot(parent) && parent.chainId) {
    const chain = readJobChain(cwd, parent.chainId);
    if (!chain) return null;
    const attention = findChainAttentionSlice(chain);
    if (!attention) return null;
    const sourceJob = readJob(cwd, attention.childJobId) ?? parent;
    return {
      chain,
      sliceId: attention.sliceId,
      rootJobId: chain.rootJobId,
      sourceJob
    };
  }

  if (isChainSliceChild(parent) && parent.chainId && parent.sliceId && parent.parentJobId) {
    const chain = readJobChain(cwd, parent.chainId);
    if (!chain) return null;
    const state = chain.sliceStates[parent.sliceId];
    if (
      state !== "failed" &&
      state !== "stalled" &&
      state !== "needs_input" &&
      state !== "blocked" &&
      state !== "timeout"
    ) {
      return null;
    }
    return {
      chain,
      sliceId: parent.sliceId,
      rootJobId: parent.parentJobId,
      sourceJob: parent
    };
  }

  return null;
}

export async function mimoStatus(
  input: unknown,
  deps: MimoStatusDependencies = {}
): Promise<RenderedJobStatus> {
  const parsed = JobStatusInput.parse(input);
  const job = parsed.jobId ? readJob(parsed.cwd, parsed.jobId) : listJobs(parsed.cwd)[0];
  if (!job) throw new Error("No jobs recorded for this workspace.");
  if (parsed.level === "compact") return renderCompactJobStatus(job);

  const processAlive = probeProcessAlive(job, deps);
  return renderJobStatus(job, {
    progress: readRecentJobLogLines(job.logFile, 5),
    notification: notificationStatus(job),
    ...(processAlive !== undefined ? { processAlive } : {})
  });
}

export interface MimoStatusDependencies {
  verifyProcess?: (
    pid: number,
    expectedIdentity: string | null | undefined
  ) => ProcessIdentityVerification;
}

function probeProcessAlive(
  job: JobRecord,
  deps: MimoStatusDependencies
): boolean | "unknown" | undefined {
  if (job.status !== "running") return undefined;
  if (typeof job.pid !== "number" || job.pid <= 0) return undefined;
  const verify = deps.verifyProcess ?? verifyProcessIdentity;
  try {
    const result = verify(job.pid, job.processIdentity);
    if (result.status === "match") return true;
    if (result.status === "not_running" || result.status === "identity_mismatch") return false;
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function mimoEvents(input: unknown) {
  const parsed = JobEventsInput.parse(input);
  const job = resolveJobForSignals(parsed.cwd, parsed.jobId);
  return renderJobSignals(job, readJobSignalPage(job.signalsFile, {
    sinceCursor: parsed.sinceCursor,
    limit: parsed.limit,
    minLevel: parsed.minLevel
  }));
}

export interface MimoWaitDependencies {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  intervalMs?: number;
  readSignals?: typeof readAttentionSignals;
}

/** Timeout guidance only; never promises cancel as an automatic next step. */
export type MimoWaitNextAction = "status_once" | "stop";

export async function mimoWait(input: unknown, deps: MimoWaitDependencies = {}) {
  const parsed = JobWaitInput.parse(input);
  const selected = resolveJobForSignals(parsed.cwd, parsed.jobId);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? delay;
  const intervalMs = deps.intervalMs ?? WAIT_CHECK_INTERVAL_MS;
  const readSignals = deps.readSignals ?? readAttentionSignals;
  const startedAt = now();
  const deadline = startedAt + parsed.timeoutMs;
  let job = selected;
  let scanCursor = parsed.sinceCursor;
  let result = readSignals(job, { ...parsed, sinceCursor: scanCursor });

  while (result.signals.length === 0 && now() < deadline) {
    scanCursor = result.nextCursor;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - now())));
    job = readJob(parsed.cwd, selected.id) ?? job;
    result = readSignals(job, { ...parsed, sinceCursor: scanCursor });
  }

  if (result.signals.length === 0) scanCursor = result.nextCursor;
  const visibleResult = result.signals.length === 0
    ? { signals: [], nextCursor: scanCursor }
    : result;

  const timedOut = result.signals.length === 0;
  return {
    ...renderJobSignals(job, visibleResult),
    timedOut,
    waitedMs: Math.max(0, now() - startedAt),
    ...(timedOut ? {
      diagnosis: publicProgressSummary({
        type: "job",
        status: job.status,
        ...(job.phase ? { phase: job.phase } : {})
      }),
      nextAction: (job.status === "queued" || job.status === "running"
        ? "status_once"
        : "stop") as MimoWaitNextAction
    } : {})
  };
}

export async function mimoResult(input: unknown): Promise<RenderedJobResult> {
  const parsed = JobResultInput.parse(input);
  const job = parsed.jobId
    ? readJob(parsed.cwd, parsed.jobId)
    : listJobs(parsed.cwd).find((candidate) => isResultStatus(candidate.status));
  if (!job) {
    throw new Error(parsed.jobId
      ? `No job found for ${parsed.jobId}.`
      : "No job results recorded for this workspace.");
  }
  if (!isResultStatus(job.status)) {
    throw new Error(`Job result is not available while ${job.id} is ${job.status}.`);
  }

  if (parsed.level === "full") {
    const fallbackOutput = job.reportPaths?.result
      ? undefined
      : readFinalJobOutput(job.eventsFile);
    return renderFullJobResult(job, {
      notification: notificationStatus(job),
      ...readJobDiagnostics(job, fallbackOutput)
    });
  }

  const output = isSemanticResultJob(job) ? readSavedJobOutput(job) : undefined;
  if (parsed.level === "compact") {
    return renderCompactJobResult(job, { output });
  }
  return renderJobResult(job, {
    notification: notificationStatus(job),
    output,
    keyError: readKeyVerificationError(job.reportPaths?.verification)
  });
}

export interface MimoJobsDependencies {
  recoverStaleQueuedJobs?: typeof recoverStaleQueuedJobs;
}

export async function mimoJobs(input: unknown, deps: MimoJobsDependencies = {}) {
  const parsed = JobListInput.parse(input);
  await (deps.recoverStaleQueuedJobs ?? recoverStaleQueuedJobs)(parsed.cwd);
  const jobs = listJobs(parsed.cwd);
  const deliveries = readNotificationDeliveries(parsed.cwd);
  return (parsed.all ? jobs : jobs.slice(0, 8)).map((job) => renderJobStatus(job, {
    progress: readRecentJobLogLines(job.logFile, 3),
    notification: notificationStatus(job, deliveries)
  }));
}

export interface MimoCancelDependencies {
  transitionJob?: typeof transitionJob;
  terminateProcess?: (
    pid: number | null | undefined,
    processIdentity: string | null | undefined
  ) => OwnedProcessTermination;
  spawnNotificationWorker?: typeof spawnNotificationWorker;
  requestJobCancellation?: typeof requestJobCancellation;
  waitForCancellation?: (cwd: string, jobId: string) => Promise<JobRecord>;
}

export async function mimoCancel(input: unknown, deps: MimoCancelDependencies = {}) {
  const parsed = JobCancelInput.parse(input);
  const existing = readJob(parsed.cwd, parsed.jobId);
  if (!existing) throw new Error(`No job found for ${parsed.jobId}.`);
  if (existing.status === "cancelled") {
    return renderJobResult(existing, { notification: notificationStatus(existing) });
  }
  if (existing.status !== "queued" && existing.status !== "running") {
    throw new Error(`Job ${existing.id} cannot be cancelled while ${existing.status}.`);
  }

  // Chain roots: stop remaining pending slices and cancel the live write child first.
  if (isChainOrchestratorRoot(existing) && existing.chainId) {
    await cascadeCancelChainRoot(parsed.cwd, existing, deps);
  }

  const requested = await (deps.requestJobCancellation ?? requestJobCancellation)(
    parsed.cwd,
    existing.id
  );
  if (requested.status === "cancelled") {
    return renderJobResult(requested, { notification: notificationStatus(requested) });
  }
  if (requested.status !== "queued" && requested.status !== "running") {
    throw new Error(`Job ${requested.id} cannot be cancelled while ${requested.status}.`);
  }

  let transitioned;
  try {
    transitioned = await withProcessLock(
      `${resolveJobPaths(parsed.cwd, existing.id).jobFile}.worker-ownership`,
      async () => {
        const current = readJob(parsed.cwd, existing.id);
        if (!current) throw new Error(`No job found for ${existing.id}.`);
        if (current.status === "cancelled") return undefined;
        if (current.status !== "queued" && current.status !== "running") {
          throw new Error(`Job ${current.id} cannot be cancelled while ${current.status}.`);
        }
        if (current.status === "running" && current.pid !== null) {
          const termination = (deps.terminateProcess ?? terminateOwnedJobProcess)(
            current.pid,
            current.processIdentity
          );
          if (termination.status === "unconfirmed") {
            throw new Error(
              `Cancellation could not be confirmed for ${current.id}: ${termination.evidence}`
            );
          }
        }
        return (deps.transitionJob ?? transitionJob)(parsed.cwd, current.id, {
          status: "cancelled",
          summary: `Cancelled ${current.id}.`,
          errorCode: "cancelled"
        });
      },
      { timeoutMs: 0 }
    );
  } catch (error) {
    if (error instanceof ProcessLockUnavailableError) {
      const pending = await (deps.waitForCancellation ?? waitForCancellation)(
        parsed.cwd,
        existing.id
      );
      if (pending.status === "cancelled") {
        return renderJobResult(pending, { notification: notificationStatus(pending) });
      }
      return renderJobStatus(pending, {
        progress: readRecentJobLogLines(pending.logFile, 3),
        notification: notificationStatus(pending)
      });
    }
    const raced = readJob(parsed.cwd, existing.id);
    if (raced?.status === "cancelled") {
      return renderJobResult(raced, { notification: notificationStatus(raced) });
    }
    throw error;
  }

  if (!transitioned) {
    const cancelled = readJob(parsed.cwd, existing.id);
    if (!cancelled || cancelled.status !== "cancelled") {
      throw new Error(`Cancellation did not finalize ${existing.id}.`);
    }
    return renderJobResult(cancelled, { notification: notificationStatus(cancelled) });
  }

  if (transitioned.deliveryCreated) {
    startNotificationDispatch(parsed.cwd, {
      spawnNotificationWorker: deps.spawnNotificationWorker
    });
  }
  return renderJobResult(transitioned.job, { notification: notificationStatus(transitioned.job) });
}

async function cascadeCancelChainRoot(
  cwd: string,
  root: JobRecord,
  deps: MimoCancelDependencies
): Promise<void> {
  if (!root.chainId) return;
  const chain = readJobChain(cwd, root.chainId);
  if (!chain) return;

  markPendingSlicesCancelled(cwd, root.chainId);

  const childId = resolveLiveChainChildJobId(chain);
  if (!childId || childId === root.id) return;
  const child = readJob(cwd, childId);
  if (!child) return;
  if (child.status !== "queued" && child.status !== "running") {
    if (child.sliceId && isChainSliceChild(child)) {
      const latest = readJobChain(cwd, root.chainId);
      const state = latest?.sliceStates[child.sliceId];
      if (state === "running" || state === "pending") {
        markSliceTerminal(cwd, root.chainId, child.sliceId, "cancelled");
      }
    }
    return;
  }

  try {
    await mimoCancel({ cwd, jobId: child.id }, deps);
  } catch {
    // Best-effort cascade: root cancel still proceeds; advance gates block further slices.
    await (deps.requestJobCancellation ?? requestJobCancellation)(cwd, child.id).catch(() => undefined);
  }

  const cancelledChild = readJob(cwd, child.id);
  if (!cancelledChild || !isChainSliceChild(cancelledChild)) return;
  if (cancelledChild.status === "queued" || cancelledChild.status === "running") {
    return;
  }

  try {
    await advanceJobChainAfterChild({ cwd, child: cancelledChild });
  } catch {
    if (cancelledChild.sliceId) {
      const latest = readJobChain(cwd, root.chainId);
      const state = latest?.sliceStates[cancelledChild.sliceId];
      if (state === "running" || state === "pending") {
        markSliceTerminal(cwd, root.chainId, cancelledChild.sliceId, "cancelled");
      }
    }
  }
}

async function waitForCancellation(cwd: string, jobId: string): Promise<JobRecord> {
  const deadline = Date.now() + 250;
  while (true) {
    const job = readJob(cwd, jobId);
    if (!job) throw new Error(`No job found for ${jobId}.`);
    if (job.status !== "running" || !job.cancellationRequestedAt || Date.now() >= deadline) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function resolveJobForSignals(cwd: string, jobId?: string): JobRecord {
  const job = jobId ? readJob(cwd, jobId) : listJobs(cwd)[0];
  if (!job) {
    throw new Error(jobId ? `No job found for ${jobId}.` : "No jobs recorded for this workspace.");
  }
  return job;
}

function readAttentionSignals(
  job: JobRecord,
  options: { sinceCursor: number; limit: number; minLevel: "debug" | "info" | "warn" | "error" }
) {
  return readJobSignalPage(job.signalsFile, {
    sinceCursor: options.sinceCursor,
    minLevel: options.minLevel,
    limit: options.limit,
    include: isAttentionSignal
  });
}

function renderJobSignals(job: JobRecord, result: JobSignalReadResult) {
  const canCancel = job.status === "queued" || job.status === "running";
  const canReadResult = isResultStatus(job.status);
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    ...(job.phase ? { phase: job.phase } : {}),
    nextCursor: result.nextCursor,
    signals: result.signals,
    actions: {
      status: "mimo_status" as const,
      ...(canCancel ? { cancel: "mimo_cancel" as const } : {}),
      ...(canReadResult ? { result: "mimo_result" as const } : {}),
      ...(job.status === "needs_input" ||
        job.status === "blocked" ||
        job.status === "stalled" ||
        job.status === "timeout" ||
        (job.status === "failed" &&
          job.errorCode !== undefined &&
          RESUMABLE_FAILURE_CODES.has(job.errorCode))
        ? { resume: "mimo_resume" as const }
        : {})
    }
  };
}

function notificationStatus(
  job: JobRecord,
  deliveries?: readonly NotificationDelivery[]
): JobNotificationStatus | undefined {
  if (!job.notificationTarget) return undefined;
  const summary = summarizeJobNotification(job, deliveries ?? readNotificationDeliveries(job.cwd));
  if (!summary) return undefined;
  return {
    targetType: summary.type,
    status: summary.status,
    attempts: summary.attempts,
    ...(summary.lastError === undefined ? {} : { lastError: summary.lastError }),
    ...(summary.errorCode === undefined ? {} : { errorCode: summary.errorCode })
  };
}

function isResultStatus(status: JobRecord["status"]): boolean {
  return status !== "queued" && status !== "running";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
