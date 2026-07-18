import {
  bindJobDefinition,
  type BoundJobDefinition,
  type JobExecutionFinalizeContext
} from "./job-definitions.js";
import { appendJobLogLine, appendRawAndNormalizedEvent } from "./job-log.js";
import { listWebhookSecretEnvironmentNames, readJob, resolveJobPaths } from "./job-store.js";
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
    if (initial.cancellationRequestedAt && initial.pid === null) {
      termination = { status: "not_running", evidence: "No MiMoCode process was recorded." };
    } else {
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
    }
    const safe = termination.status !== "unconfirmed";
    if (initial.cancellationRequestedAt) {
      if (!safe) {
        bestEffortLog(
          initial.logFile,
          `Cancellation remains pending because process termination was not confirmed: ${termination.evidence}`
        );
        return;
      }
      const cancelled = await transitionRecoverably(cwd, jobId, {
        status: "cancelled",
        summary: `Cancelled ${jobId}.`,
        errorCode: "cancelled"
      }, deps);
      if (cancelled.deliveryCreated) startNotificationWorker(cwd, cancelled.job, deps);
      return;
    }
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
    const prompt = await awaitWithAbort(
      definition.buildPrompt(executionGuard.signal),
      executionGuard.signal
    );
    assertJobActive(cwd, jobId, executionGuard.signal);
    const mimoArgs = definition.buildMimoArgs(prompt);
    const captureStatus = deps.captureStatus ?? captureGitStatus;
    const captureHead = deps.captureHead ?? captureGitHead;
    const gitStatusBefore = withoutRuntimeStatus(
      await awaitWithAbort(
        captureStatus(cwd, { signal: executionGuard.signal }),
        executionGuard.signal
      )
    );
    assertJobActive(cwd, jobId, executionGuard.signal);
    const gitHeadBefore = await awaitWithAbort(
      captureHead(cwd, { signal: executionGuard.signal }),
      executionGuard.signal
    );
    assertJobActive(cwd, jobId, executionGuard.signal);

    stage = "hook";
    hook = await awaitWithAbort(
      (deps.createHookCallbackController ?? createHookCallbackController)({
        cwd,
        kind: initial.kind
      }),
      executionGuard.signal,
      {
        onAbandonedResolve: async (lateHook) => {
          try {
            await lateHook.close();
          } catch (error) {
            bestEffortJobLog(
              cwd,
              jobId,
              `Failed to close late MiMoCode callback controller: ${errorMessage(error)}`
            );
          }
        }
      }
    );
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
    let processTerminationConfirmed = false;
    try {
      run = await (deps.runMimoStreaming ?? runMimoCliStreaming)(cwd, mimoArgs, {
          timeoutMs: readTimeout(initial.request),
          env: hook.env,
          omitEnv: listWebhookSecretEnvironmentNames(cwd),
          signal: executionGuard.signal,
          onStart: async (pid) => {
            const captured = (deps.captureProcessIdentity ?? captureProcessIdentity)(pid);
            if (captured.status !== "running") {
              throw new Error(`MiMoCode process identity unavailable: ${captured.evidence}`);
            }
            const updated = await awaitWithAbort(
              (deps.updateRunningJobProcess ?? updateRunningJobProcess)(
                cwd,
                jobId,
                pid,
                captured.identity
              ),
              executionGuard!.signal
            );
            if (updated.status !== "running") executionGuard!.abort(updated.status);
          },
          onLine: (line) => queueEventWrite(async () =>
            (deps.appendRawAndNormalizedEvent ?? appendRawAndNormalizedEvent)(cwd, jobId, line))
        });
      processTerminationConfirmed = true;
    } finally {
      if (processTerminationConfirmed) {
        await (deps.updateRunningJobProcess ?? updateRunningJobProcess)(cwd, jobId, null, null);
      }
    }
    if (requireJob(cwd, jobId).cancellationRequestedAt) {
      executionGuard.stop();
      const cancelled = await transitionRecoverably(cwd, jobId, {
        status: "cancelled",
        summary: `Cancelled ${jobId}.`,
        errorCode: "cancelled"
      }, deps);
      if (cancelled.deliveryCreated) startNotificationWorker(cwd, cancelled.job, deps);
      return;
    }
    await awaitWithAbort(eventWrites, executionGuard.signal);
    if (eventWriteError) throw eventWriteError;

    assertJobActive(cwd, jobId, executionGuard.signal);

    stage = "callback";
    const callbackEvidence = toExecutionCallbackEvidence(
      hook.invocationId,
      await waitForExecutionCallback(hook, executionGuard.signal)
    );
    const completedHook = hook;
    hook = undefined;
    try {
      await awaitWithAbort(completedHook.close(), executionGuard.signal);
    } catch (error) {
      executionGuard.signal.throwIfAborted();
      bestEffortJobLog(
        cwd,
        jobId,
        `Failed to close MiMoCode callback controller: ${errorMessage(error)}`
      );
    }
    assertJobActive(cwd, jobId, executionGuard.signal);

    stage = "finalize";
    const captureDiff = deps.captureDiff ?? captureGitDiff;
    const captureCommitChanges = deps.captureCommitChanges ?? captureGitCommitChanges;
    const gitStatusAfter = withoutRuntimeStatus(
      await awaitWithAbort(
        captureStatus(cwd, { signal: executionGuard.signal }),
        executionGuard.signal
      )
    );
    assertJobActive(cwd, jobId, executionGuard.signal);
    const gitHeadAfter = await awaitWithAbort(
      captureHead(cwd, { signal: executionGuard.signal }),
      executionGuard.signal
    );
    assertJobActive(cwd, jobId, executionGuard.signal);
    const capturedDiff = await awaitWithAbort(
      captureDiff(cwd, "HEAD", { signal: executionGuard.signal }),
      executionGuard.signal
    );
    assertJobActive(cwd, jobId, executionGuard.signal);
    const capturedCommitChanges = await awaitWithAbort(
      captureCommitChanges(cwd, gitHeadBefore, gitHeadAfter, { signal: executionGuard.signal }),
      executionGuard.signal
    );
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
    const outcome = await awaitWithAbort(definition.finalize(context), executionGuard.signal);

    assertJobActive(cwd, jobId, executionGuard.signal);
    executionGuard.stop();
    const result = await transition(cwd, jobId, outcome);
    bestEffortLog(result.job.logFile, outcome.summary);
    if (result.deliveryCreated) startNotificationWorker(cwd, result.job, deps);
  } catch (error) {
    if (executionGuard) {
      try {
        await awaitWithAbort(eventWrites, executionGuard.signal);
      } catch {
        // Cancellation abandons auxiliary event persistence without holding worker ownership.
      }
    } else {
      await eventWrites;
    }
    await failWorker(cwd, jobId, stage, error, deps);
  } finally {
    executionGuard?.stop();
    if (hook) {
      try {
        await awaitWithAbort(
          hook.close(),
          executionGuard?.signal ?? new AbortController().signal
        );
      } catch (error) {
        if (!executionGuard?.signal.aborted) {
          bestEffortJobLog(
            cwd,
            jobId,
            `Failed to close MiMoCode callback controller: ${errorMessage(error)}`
          );
        }
      }
    }
  }
}

async function waitForExecutionCallback(
  hook: HookCallbackController,
  signal: AbortSignal
): Promise<Awaited<ReturnType<HookCallbackController["waitForCallback"]>>> {
  return awaitWithAbort(hook.waitForCallback(), signal);
}

interface AbortAwareAwaitOptions<T> {
  onAbandonedResolve?: (value: T) => Promise<void> | void;
}

async function awaitWithAbort<T>(
  operation: PromiseLike<T> | T,
  signal: AbortSignal,
  options: AbortAwareAwaitOptions<T> = {}
): Promise<T> {
  let abandoned = signal.aborted;
  const observed = Promise.resolve(operation).then((value) => {
    if (abandoned && options.onAbandonedResolve) {
      void Promise.resolve()
        .then(() => options.onAbandonedResolve!(value))
        .catch(() => undefined);
    }
    return value;
  });
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason ?? new Error("Job execution aborted."));
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([observed, aborted]);
  } finally {
    abandoned = signal.aborted;
    signal.removeEventListener("abort", onAbort);
  }
}

interface JobExecutionGuard {
  signal: AbortSignal;
  abort(reason: JobStatus | "cancellation_requested"): void;
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
  const abort = (reason: JobStatus | "cancellation_requested") => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`Job execution stopped (${reason}).`));
    }
    stop();
  };
  const poll = () => {
    if (stopped) return;
    try {
      const job = requireJob(cwd, jobId);
      if (job.cancellationRequestedAt) {
        abort("cancellation_requested");
        return;
      }
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

  if (existing.cancellationRequestedAt) {
    if (existing.pid !== null) {
      bestEffortLog(
        existing.logFile,
        `Cancellation remains pending because process termination was not confirmed: ${errorMessage(error)}`
      );
      return;
    }
    const cancelled = await transitionRecoverably(cwd, jobId, {
      status: "cancelled",
      summary: `Cancelled ${jobId}.`,
      errorCode: "cancelled"
    }, deps);
    if (cancelled.deliveryCreated) startNotificationWorker(cwd, cancelled.job, deps);
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
