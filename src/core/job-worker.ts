import {
  bindJobDefinition,
  type BoundJobDefinition,
  type JobExecutionFinalizeContext
} from "./job-definitions.js";
import { appendJobLogLine, appendRawAndNormalizedEvent } from "./job-log.js";
import { readJob, resolveJobPaths } from "./job-store.js";
import {
  recoverPendingTransition,
  transitionJob,
  updateRunningJobProcess,
  type JobTransition,
  type JobTransitionResult
} from "./job-transition.js";
import type { JobRecord, JobStatus } from "./jobs.js";
import {
  captureGitCommitChanges,
  captureGitDiff,
  captureGitHead,
  captureGitStatus,
  type GitCommitChangeSnapshot,
  type GitDiffSnapshot,
  type GitStatusSnapshot
} from "../git/diff.js";
import {
  createHookCallbackController,
  toExecutionCallbackEvidence,
  type HookCallbackController
} from "../mimo/hook-callback.js";
import {
  runMimoCliStreaming,
  type StreamingRunResult
} from "../mimo/streaming-runner.js";
import {
  captureProcessIdentity,
  spawnNotificationWorker,
  terminateOwnedJobProcess,
  type OwnedProcessTermination
} from "./job-process.js";
import type { NormalizedMimoEvent } from "../compose/events.js";
import {
  ProcessLockUnavailableError,
  resolveProcessLockEndpoint,
  withProcessLock
} from "./process-lock.js";

export interface JobWorkerDependencies {
  bindJobDefinition?: (job: JobRecord) => BoundJobDefinition;
  createHookCallbackController?: typeof createHookCallbackController;
  runMimoStreaming?: typeof runMimoCliStreaming;
  captureStatus?: typeof captureGitStatus;
  captureHead?: typeof captureGitHead;
  captureDiff?: typeof captureGitDiff;
  captureCommitChanges?: typeof captureGitCommitChanges;
  transitionJob?: typeof transitionJob;
  recoverPendingTransition?: typeof recoverPendingTransition;
  updateRunningJobProcess?: typeof updateRunningJobProcess;
  appendRawAndNormalizedEvent?: typeof appendRawAndNormalizedEvent;
  spawnNotificationWorker?: typeof spawnNotificationWorker;
  captureProcessIdentity?: typeof captureProcessIdentity;
  terminateOwnedProcess?: typeof terminateOwnedJobProcess;
  statusPollMs?: number;
}

type WorkerStage = "starting" | "prompt" | "hook" | "run" | "callback" | "finalize";

const TERMINAL_STATUSES = new Set<JobStatus>([
  "needs_input",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "timeout"
]);

export async function runJobWorker(
  cwd: string,
  jobId: string,
  deps: JobWorkerDependencies = {}
): Promise<void> {
  const ownershipKey = `${resolveJobPaths(cwd, jobId).jobFile}.worker-ownership`;
  const ownershipEndpoint = resolveProcessLockEndpoint(ownershipKey);
  try {
    await withProcessLock(ownershipKey, () => runOwnedJobWorker(cwd, jobId, deps), {
      timeoutMs: 0
    });
  } catch (error) {
    if (error instanceof ProcessLockUnavailableError && error.key === ownershipKey &&
        error.endpoint.host === ownershipEndpoint.host &&
        error.endpoint.port === ownershipEndpoint.port) {
      return;
    }
    throw error;
  }
}

async function runOwnedJobWorker(
  cwd: string,
  jobId: string,
  deps: JobWorkerDependencies
): Promise<void> {
  const recover = deps.recoverPendingTransition ?? recoverPendingTransition;
  const recovered = await recover(cwd, jobId);
  if (recovered?.deliveryCreated) startNotificationWorker(cwd, recovered.job, deps);

  const initial = requireJob(cwd, jobId);
  if (TERMINAL_STATUSES.has(initial.status)) return;

  const transition = deps.transitionJob ?? transitionJob;
  if (initial.status === "running") {
    let termination: OwnedProcessTermination;
    try {
      termination = (deps.terminateOwnedProcess ?? terminateOwnedJobProcess)(
        initial.pid ?? null,
        initial.processIdentity
      );
    } catch (error) {
      termination = {
        status: "unconfirmed",
        evidence: `Owned process recovery failed: ${errorMessage(error)}`
      };
    }
    const safe = termination.status !== "unconfirmed";
    const summary = safe
      ? `A previous worker exited; its MiMoCode process is confirmed inactive. ${termination.evidence}`
      : `MiMoCode process recovery could not be confirmed safely. ${termination.evidence}`;
    const failure: JobTransition = safe
      ? { status: "failed", summary, error: summary, errorCode: "worker_restarted" }
      : { status: "blocked", summary, error: summary, errorCode: "worker_recovery_unconfirmed" };
    const result = await transitionRecoverably(cwd, jobId, failure, deps);
    bestEffortLog(result.job.logFile, failure.error!);
    if (result.deliveryCreated) startNotificationWorker(cwd, result.job, deps);
    return;
  }
  if (initial.status !== "queued") return;

  let stage: WorkerStage = "starting";
  let hook: HookCallbackController | undefined;
  let eventWrites = Promise.resolve();
  let eventWriteError: unknown;
  let executionGuard: JobExecutionGuard | undefined;

  try {
    const definition = (deps.bindJobDefinition ?? bindJobDefinition)(initial);
    await transition(cwd, jobId, {
      status: "running",
      phase: "starting",
      summary: "Starting MiMoCode."
    });
    executionGuard = startJobExecutionGuard(cwd, jobId, deps.statusPollMs ?? 25);
    assertJobActive(cwd, jobId, executionGuard.signal);

    stage = "prompt";
    const prompt = await definition.buildPrompt();
    assertJobActive(cwd, jobId, executionGuard.signal);
    const mimoArgs = definition.buildMimoArgs(prompt);
    const captureStatus = deps.captureStatus ?? captureGitStatus;
    const captureHead = deps.captureHead ?? captureGitHead;
    const gitStatusBefore = withoutRuntimeStatus(await captureStatus(cwd));
    assertJobActive(cwd, jobId, executionGuard.signal);
    const gitHeadBefore = await captureHead(cwd);
    assertJobActive(cwd, jobId, executionGuard.signal);

    stage = "hook";
    hook = await (deps.createHookCallbackController ?? createHookCallbackController)({
      cwd,
      kind: initial.kind
    });
    assertJobActive(cwd, jobId, executionGuard.signal);

    const events: NormalizedMimoEvent[] = [];
    const queueEventWrite = (action: () => Promise<NormalizedMimoEvent | undefined>) => {
      eventWrites = eventWrites.then(async () => {
        try {
          const result = await action();
          if (result && "raw" in result) events.push(result);
        } catch (error) {
          eventWriteError ??= error;
        }
      });
    };

    stage = "run";
    let run: StreamingRunResult;
    try {
      run = await (deps.runMimoStreaming ?? runMimoCliStreaming)(cwd, mimoArgs, {
        timeoutMs: readTimeout(initial.request),
        env: hook.env,
        signal: executionGuard.signal,
        onStart: async (pid) => {
          const captured = (deps.captureProcessIdentity ?? captureProcessIdentity)(pid);
          if (captured.status !== "running") {
            throw new Error(`MiMoCode process identity unavailable: ${captured.evidence}`);
          }
          const updated = await (deps.updateRunningJobProcess ?? updateRunningJobProcess)(
            cwd,
            jobId,
            pid,
            captured.identity
          );
          if (updated.status !== "running") executionGuard!.abort(updated.status);
        },
        onLine: (line) => queueEventWrite(async () =>
          (deps.appendRawAndNormalizedEvent ?? appendRawAndNormalizedEvent)(cwd, jobId, line))
      });
    } finally {
      await (deps.updateRunningJobProcess ?? updateRunningJobProcess)(cwd, jobId, null, null);
    }
    await eventWrites;
    if (eventWriteError) throw eventWriteError;

    assertJobActive(cwd, jobId, executionGuard.signal);

    stage = "callback";
    const callbackEvidence = toExecutionCallbackEvidence(
      hook.invocationId,
      await waitForExecutionCallback(hook, executionGuard.signal)
    );
    assertJobActive(cwd, jobId, executionGuard.signal);

    stage = "finalize";
    const captureDiff = deps.captureDiff ?? captureGitDiff;
    const captureCommitChanges = deps.captureCommitChanges ?? captureGitCommitChanges;
    const gitStatusAfter = withoutRuntimeStatus(await captureStatus(cwd));
    assertJobActive(cwd, jobId, executionGuard.signal);
    const gitHeadAfter = await captureHead(cwd);
    assertJobActive(cwd, jobId, executionGuard.signal);
    const capturedDiff = await captureDiff(cwd);
    assertJobActive(cwd, jobId, executionGuard.signal);
    const capturedCommitChanges = await captureCommitChanges(cwd, gitHeadBefore, gitHeadAfter);
    assertJobActive(cwd, jobId, executionGuard.signal);
    const diff = withoutRuntimeDiff(capturedDiff);
    const commitChanges = withoutRuntimeCommitChanges(capturedCommitChanges);
    const context: JobExecutionFinalizeContext = {
      mimoArgs,
      run,
      events,
      executionCallback: callbackEvidence.executionCallback,
      callbackFinalText: callbackEvidence.callbackFinalText,
      gitStatusBefore,
      gitStatusAfter,
      gitHeadBefore,
      gitHeadAfter,
      diff,
      commitChanges,
      signal: executionGuard.signal
    };
    const outcome = await definition.finalize(context);

    assertJobActive(cwd, jobId, executionGuard.signal);
    const result = await transition(cwd, jobId, outcome);
    bestEffortLog(result.job.logFile, outcome.summary);
    if (result.deliveryCreated) startNotificationWorker(cwd, result.job, deps);
  } catch (error) {
    await eventWrites;
    await failWorker(cwd, jobId, stage, error, deps);
  } finally {
    executionGuard?.stop();
    if (hook) {
      try {
        await hook.close();
      } catch (error) {
        bestEffortJobLog(
          cwd,
          jobId,
          `Failed to close MiMoCode callback controller: ${errorMessage(error)}`
        );
      }
    }
  }
}

async function waitForExecutionCallback(
  hook: HookCallbackController,
  signal: AbortSignal
): Promise<Awaited<ReturnType<HookCallbackController["waitForCallback"]>>> {
  signal.throwIfAborted();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason ?? new Error("Job execution aborted."));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([hook.waitForCallback(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

interface JobExecutionGuard {
  signal: AbortSignal;
  abort(status: JobStatus): void;
  stop(): void;
}

function startJobExecutionGuard(cwd: string, jobId: string, pollMs: number): JobExecutionGuard {
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const abort = (status: JobStatus) => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`Job is no longer active (${status}).`));
    }
    stop();
  };
  const poll = () => {
    if (stopped) return;
    try {
      const job = requireJob(cwd, jobId);
      if (job.status !== "running") {
        abort(job.status);
        return;
      }
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(error);
      stop();
      return;
    }
    timer = setTimeout(poll, pollMs);
    timer.unref?.();
  };
  timer = setTimeout(poll, 0);
  timer.unref?.();
  return { signal: controller.signal, abort, stop };
}

function assertJobActive(cwd: string, jobId: string, signal: AbortSignal): void {
  signal.throwIfAborted();
  const job = requireJob(cwd, jobId);
  if (job.status !== "running") {
    throw new Error(`Job is no longer active (${job.status}).`);
  }
}

async function transitionRecoverably(
  cwd: string,
  jobId: string,
  request: JobTransition,
  deps: JobWorkerDependencies
): Promise<JobTransitionResult> {
  try {
    return await (deps.transitionJob ?? transitionJob)(cwd, jobId, request);
  } catch (error) {
    const recovered = await (deps.recoverPendingTransition ?? recoverPendingTransition)(cwd, jobId);
    if (!recovered) throw error;
    return recovered;
  }
}

async function failWorker(
  cwd: string,
  jobId: string,
  stage: WorkerStage,
  error: unknown,
  deps: JobWorkerDependencies
): Promise<void> {
  const existing = requireJob(cwd, jobId);
  if (TERMINAL_STATUSES.has(existing.status)) {
    const recovered = await (deps.recoverPendingTransition ?? recoverPendingTransition)(cwd, jobId);
    if (recovered?.deliveryCreated) startNotificationWorker(cwd, recovered.job, deps);
    return;
  }

  const message = errorMessage(error);
  const failure: JobTransition = {
    status: "failed",
    summary: `${stageLabel(stage)}: ${message}`,
    error: `${stageLabel(stage)}: ${message}`,
    errorCode: stageErrorCode(stage)
  };
  let result: JobTransitionResult;
  try {
    result = await (deps.transitionJob ?? transitionJob)(cwd, jobId, failure);
  } catch {
    const recovered = await (deps.recoverPendingTransition ?? recoverPendingTransition)(cwd, jobId);
    if (!recovered) throw error;
    result = recovered;
  }
  bestEffortLog(result.job.logFile, failure.error!);
  if (result.deliveryCreated) startNotificationWorker(cwd, result.job, deps);
}

function startNotificationWorker(
  cwd: string,
  job: JobRecord,
  deps: JobWorkerDependencies
): void {
  try {
    (deps.spawnNotificationWorker ?? spawnNotificationWorker)(cwd);
  } catch (error) {
    bestEffortLog(
      job.logFile,
      `Notification worker could not start; pending delivery remains recoverable: ${errorMessage(error)}`
    );
  }
}

function readTimeout(request: unknown): number {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return 1_800_000;
  const timeoutMs = (request as Record<string, unknown>).timeoutMs;
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : 1_800_000;
}

function requireJob(cwd: string, jobId: string): JobRecord {
  const job = readJob(cwd, jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  return job;
}

function stageLabel(stage: WorkerStage): string {
  const labels: Record<WorkerStage, string> = {
    starting: "Job startup failed",
    prompt: "Job prompt setup failed",
    hook: "MiMoCode callback setup failed",
    run: "MiMoCode execution failed",
    callback: "MiMoCode callback wait failed",
    finalize: "Job finalization failed"
  };
  return labels[stage];
}

function stageErrorCode(stage: WorkerStage): string {
  const codes: Record<WorkerStage, string> = {
    starting: "worker_startup_failed",
    prompt: "prompt_setup_failed",
    hook: "callback_setup_failed",
    run: "mimo_run_failed",
    callback: "callback_wait_failed",
    finalize: "finalize_failed"
  };
  return codes[stage];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bestEffortLog(file: string, message: string): void {
  try {
    appendJobLogLine(file, message);
  } catch {
    // The persisted job/outbox is authoritative; diagnostics must not replace the outcome.
  }
}

function bestEffortJobLog(cwd: string, jobId: string, message: string): void {
  try {
    const job = readJob(cwd, jobId);
    if (job) bestEffortLog(job.logFile, message);
  } catch {
    // Closing an auxiliary callback server must never replace the worker result.
  }
}

function withoutRuntimeStatus(status: GitStatusSnapshot): GitStatusSnapshot {
  const fingerprints = Object.fromEntries(
    Object.entries(status.fingerprints).filter(([file]) => !isRuntimePath(file))
  );
  const short = status.short
    .split(/\r?\n/)
    .filter((line) => !isRuntimePath(line.replace(/^[ MADRCU?!]{2}\s+/, "")))
    .join("\n");
  return { short, dirty: Object.keys(fingerprints).length > 0, fingerprints };
}

function withoutRuntimeDiff(diff: GitDiffSnapshot): GitDiffSnapshot {
  return {
    ...diff,
    changedFiles: diff.changedFiles.filter((file) => !isRuntimePath(file))
  };
}

function withoutRuntimeCommitChanges(changes: GitCommitChangeSnapshot): GitCommitChangeSnapshot {
  return {
    ...changes,
    changedFiles: changes.changedFiles.filter((file) => !isRuntimePath(file))
  };
}

function isRuntimePath(file: string): boolean {
  const normalized = file.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized === ".codex-mimo" || normalized.startsWith(".codex-mimo/");
}
