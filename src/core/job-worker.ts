import fs from "node:fs";
import {
  bindJobDefinition,
  type BoundJobDefinition,
  type JobExecutionFinalizeContext
} from "./job-definitions.js";
import { appendJobLogLine, appendRawAndNormalizedEvent } from "./job-log.js";
import { listWebhookSecretEnvironmentNames, readJob } from "./job-store.js";
import {
  recoverPendingTransition,
  transitionJob,
  updateRunningJobObservation,
  updateRunningJobProcess,
  type JobTransition,
  type JobTransitionResult
} from "./job-transition.js";
import { isTerminalJobStatus, nowIso, type JobRecord, type JobStatus } from "./jobs.js";
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
  resolveJobWorkerOwnershipKey,
  terminateOwnedJobProcess,
  type OwnedProcessTermination
} from "./job-process.js";
import { startNotificationDispatch } from "../notify/dispatch-process.js";
import { spawnNotificationWorker } from "./job-process.js";
import type { NormalizedMimoEvent } from "../compose/events.js";
import {
  extractSessionIdFromRawLine,
  extractToolNameFromRawLine,
  parseMimoJsonLines
} from "../compose/events.js";
import {
  ProcessLockUnavailableError,
  resolveProcessLockEndpoint,
  withProcessLock
} from "./process-lock.js";
import { isRuntimeArtifactPath } from "./runtime-paths.js";
import type { PublicSummaryContext } from "./public-summary.js";
import { captureTerminalArtifacts } from "./job-artifacts.js";
import type { PhaseOscillationResult } from "../compose/phase-loop.js";
import { errorMessage } from "./errors.js";
import { sleep as defaultSleep } from "./sleep.js";
import {
  readRequestIdleTimeoutMs,
  readRequestTimeoutMs
} from "./job-timeouts.js";

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
  updateRunningJobObservation?: typeof updateRunningJobObservation;
  appendRawAndNormalizedEvent?: typeof appendRawAndNormalizedEvent;
  spawnNotificationWorker?: typeof spawnNotificationWorker;
  captureProcessIdentity?: typeof captureProcessIdentity;
  terminateOwnedProcess?: typeof terminateOwnedJobProcess;
  statusPollMs?: number;
  recoveryRetryMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

type WorkerStage = "starting" | "prompt" | "hook" | "run" | "callback" | "finalize";

export async function runJobWorker(
  cwd: string,
  jobId: string,
  deps: JobWorkerDependencies = {}
): Promise<void> {
  const ownershipKey = resolveJobWorkerOwnershipKey(cwd, jobId);
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
  if (isTerminalJobStatus(initial.status)) return;

  const transition = deps.transitionJob ?? transitionJob;
  if (initial.status === "running") {
    const recovered = await recoverOwnedProcess(cwd, jobId, deps);
    if (!recovered) return;
    if (recovered.job.cancellationRequestedAt) {
      const cancelled = await transitionRecoverably(cwd, jobId, {
        status: "cancelled",
        summary: `Cancelled ${jobId}.`,
        errorCode: "cancelled"
      }, deps);
      if (cancelled.deliveryCreated) startNotificationWorker(cwd, cancelled.job, deps);
      return;
    }
    const timedOut = jobDeadlineExpired(recovered.job);
    const summary = timedOut
      ? "MiMoCode job timed out."
      : "A previous worker exited; its MiMoCode process is confirmed inactive.";
    const failure: JobTransition = timedOut
      ? { status: "timeout", summary, error: summary, errorCode: "timeout" }
      : { status: "failed", summary, error: summary, errorCode: "worker_restarted" };
    const result = await transitionRecoverably(cwd, jobId, failure, deps);
    bestEffortLog(result.job.logFile, { type: "job", status: result.job.status });
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
          } catch {
            bestEffortJobLog(cwd, jobId);
          }
        }
      }
    );
    assertJobActive(cwd, jobId, executionGuard.signal);

    const events: NormalizedMimoEvent[] = [];
    let phaseOscillation: PhaseOscillationResult | undefined;
    const queueEventWrite = (action: () => Promise<
      | NormalizedMimoEvent
      | { event: NormalizedMimoEvent; oscillation?: PhaseOscillationResult }
      | undefined
    >) => {
      eventWrites = eventWrites.then(async () => {
        try {
          const result = await action();
          if (!result) return;
          const event = "raw" in result ? result : result.event;
          if (event && "raw" in event) events.push(event);
          if (result && "oscillation" in result && result.oscillation?.oscillating) {
            phaseOscillation ??= result.oscillation;
            executionGuard?.abort("needs_input");
          }
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
          timeoutMs: readRequestTimeoutMs(initial.request),
          idleTimeoutMs: readRequestIdleTimeoutMs(initial.request),
          env: hook.env,
          omitEnv: listWebhookSecretEnvironmentNames(cwd),
          signal: executionGuard.signal,
          onStart: async (pid) => {
            const persistProcess = deps.updateRunningJobProcess ?? updateRunningJobProcess;
            const persistObservation = deps.updateRunningJobObservation ?? updateRunningJobObservation;
            await persistObservation(cwd, jobId, { lastEventAt: nowIso() });
            const provisional = await awaitWithAbort(
              persistProcess(cwd, jobId, pid, null),
              executionGuard!.signal
            );
            if (provisional.status !== "running") {
              executionGuard!.abort(provisional.status);
              return;
            }
            const captured = (deps.captureProcessIdentity ?? captureProcessIdentity)(pid);
            if (captured.status !== "running") {
              throw new Error(`MiMoCode process identity unavailable: ${captured.evidence}`);
            }
            const owned = await awaitWithAbort(
              persistProcess(cwd, jobId, pid, captured.identity),
              executionGuard!.signal
            );
            if (owned.status !== "running") executionGuard!.abort(owned.status);
          },
          onLine: (line) => {
            queueEventWrite(async () =>
              (deps.appendRawAndNormalizedEvent ?? appendRawAndNormalizedEvent)(cwd, jobId, line));
            const persistObservation = deps.updateRunningJobObservation ?? updateRunningJobObservation;
            const sessionId = extractSessionIdFromRawLine(line);
            const toolName = extractToolNameFromRawLine(line);
            void persistObservation(cwd, jobId, {
              lastEventAt: nowIso(),
              ...(sessionId ? { sessionId } : {}),
              ...(toolName ? { lastTool: toolName } : {})
            }).catch(() => undefined);
          }
        });
      processTerminationConfirmed = true;
    } finally {
      if (processTerminationConfirmed) {
        await (deps.updateRunningJobProcess ?? updateRunningJobProcess)(cwd, jobId, null, null);
      }
    }
    try {
      await awaitWithAbort(eventWrites, executionGuard.signal);
    } catch {
      // Cancellation/oscillation aborts auxiliary event persistence without holding ownership.
    }
    if (eventWriteError) throw eventWriteError;

    if (phaseOscillation?.oscillating) {
      executionGuard.stop();
      const artifacts = await captureTerminalArtifacts(cwd, events, {
        captureDiff: deps.captureDiff ?? captureGitDiff
      });
      const pair = phaseOscillation.pair?.join(" ↔ ") ?? "phase";
      const paused = await transitionRecoverably(cwd, jobId, {
        status: "needs_input",
        summary:
          `MiMoCode phase oscillation detected (${pair}, ${phaseOscillation.flipCount} flips). ` +
          "Resume with adjudication or cancel.",
        errorCode: "phase_oscillation",
        changedFiles: artifacts.changedFiles
      }, deps);
      if (paused.deliveryCreated) startNotificationWorker(cwd, paused.job, deps);
      return;
    }

    if (requireJob(cwd, jobId).cancellationRequestedAt) {
      executionGuard.stop();
      const artifacts = await captureTerminalArtifacts(cwd, events, {
        captureDiff: deps.captureDiff ?? captureGitDiff
      });
      const cancelled = await transitionRecoverably(cwd, jobId, {
        status: "cancelled",
        summary: `Cancelled ${jobId}.`,
        errorCode: "cancelled",
        changedFiles: artifacts.changedFiles
      }, deps);
      if (cancelled.deliveryCreated) startNotificationWorker(cwd, cancelled.job, deps);
      return;
    }

    assertJobActive(cwd, jobId, executionGuard.signal);

    stage = "callback";
    const callbackEvidence = toExecutionCallbackEvidence(
      hook.invocationId,
      await awaitWithAbort(hook.waitForCallback(), executionGuard.signal)
    );
    const completedHook = hook;
    hook = undefined;
    try {
      await awaitWithAbort(completedHook.close(), executionGuard.signal);
    } catch {
      executionGuard.signal.throwIfAborted();
      bestEffortJobLog(cwd, jobId);
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
    bestEffortLog(result.job.logFile, { type: "job", status: result.job.status });
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
      } catch {
        if (!executionGuard?.signal.aborted) {
          bestEffortJobLog(cwd, jobId);
        }
      }
    }
  }
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
  let existing = requireJob(cwd, jobId);
  if (isTerminalJobStatus(existing.status)) {
    const recovered = await (deps.recoverPendingTransition ?? recoverPendingTransition)(cwd, jobId);
    if (recovered?.deliveryCreated) startNotificationWorker(cwd, recovered.job, deps);
    return;
  }

  if (existing.pid !== null) {
    const recovered = await recoverOwnedProcess(cwd, jobId, deps);
    if (!recovered) return;
    existing = recovered.job;
  }

  if (existing.cancellationRequestedAt) {
    const artifacts = await captureTerminalArtifactsBestEffort(cwd, existing, deps);
    const cancelled = await transitionRecoverably(cwd, jobId, {
      status: "cancelled",
      summary: `Cancelled ${jobId}.`,
      errorCode: "cancelled",
      ...(artifacts.changedFiles.length > 0 ? { changedFiles: artifacts.changedFiles } : {})
    }, deps);
    if (cancelled.deliveryCreated) startNotificationWorker(cwd, cancelled.job, deps);
    return;
  }

  if (jobDeadlineExpired(existing)) {
    const artifacts = await captureTerminalArtifactsBestEffort(cwd, existing, deps);
    const timedOut = await transitionRecoverably(cwd, jobId, {
      status: "timeout",
      summary: "MiMoCode job timed out.",
      error: "MiMoCode job timed out.",
      errorCode: "timeout",
      ...(artifacts.changedFiles.length > 0 ? { changedFiles: artifacts.changedFiles } : {})
    }, deps);
    if (timedOut.deliveryCreated) startNotificationWorker(cwd, timedOut.job, deps);
    return;
  }

  const message = errorMessage(error);
  const artifacts = await captureTerminalArtifactsBestEffort(cwd, existing, deps);
  const failure: JobTransition = {
    status: "failed",
    summary: `${stageLabel(stage)}: ${message}`,
    error: `${stageLabel(stage)}: ${message}`,
    errorCode: stageErrorCode(stage),
    ...(artifacts.changedFiles.length > 0 ? { changedFiles: artifacts.changedFiles } : {})
  };
  let result: JobTransitionResult;
  try {
    result = await (deps.transitionJob ?? transitionJob)(cwd, jobId, failure);
  } catch {
    const recovered = await (deps.recoverPendingTransition ?? recoverPendingTransition)(cwd, jobId);
    if (!recovered) throw error;
    result = recovered;
  }
  bestEffortLog(result.job.logFile, { type: "job", status: result.job.status });
  if (result.deliveryCreated) startNotificationWorker(cwd, result.job, deps);
}

function startNotificationWorker(
  cwd: string,
  job: JobRecord,
  deps: JobWorkerDependencies
): void {
  startNotificationDispatch(cwd, {
    spawnNotificationWorker: deps.spawnNotificationWorker,
    onError: (_error) => bestEffortLog(
      job.logFile,
      { type: "notification" }
    )
  });
}

async function recoverOwnedProcess(
  cwd: string,
  jobId: string,
  deps: JobWorkerDependencies
): Promise<{ job: JobRecord; termination: OwnedProcessTermination } | undefined> {
  const terminate = deps.terminateOwnedProcess ?? terminateOwnedJobProcess;
  const captureIdentity = deps.captureProcessIdentity ?? captureProcessIdentity;
  const sleep = deps.sleep ?? defaultSleep;
  const retryMs = Math.max(0, deps.recoveryRetryMs ?? 250);

  while (true) {
    const job = requireJob(cwd, jobId);
    if (job.status !== "running") return undefined;
    let termination: OwnedProcessTermination;
    if (job.pid === null) {
      termination = { status: "not_running", evidence: "No MiMoCode process was recorded." };
    } else if (job.processIdentity === null) {
      // Provisional ownership: never signal by PID alone (reuse hazard). Probe only.
      let probe;
      try {
        probe = captureIdentity(job.pid);
      } catch {
        probe = {
          status: "unconfirmed" as const,
          evidence: "Provisional process probe failed."
        };
      }
      termination = probe.status === "not_running"
        ? { status: "not_running", evidence: probe.evidence }
        : { status: "unconfirmed", evidence: probe.evidence };
    } else {
      try {
        termination = terminate(job.pid, job.processIdentity);
      } catch {
        termination = {
          status: "unconfirmed",
          evidence: "Owned process recovery failed."
        };
      }
    }
    if (termination.status !== "unconfirmed") return { job, termination };
    bestEffortLog(job.logFile, { type: "job", status: "running", phase: job.phase });
    await sleep(retryMs);
  }
}

function jobDeadlineExpired(job: JobRecord, now = Date.now()): boolean {
  const startedAt = Date.parse(job.startedAt ?? "");
  return Number.isFinite(startedAt) && now - startedAt >= readRequestTimeoutMs(job.request);
}

function requireJob(cwd: string, jobId: string): JobRecord {
  const job = readJob(cwd, jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  return job;
}

async function captureTerminalArtifactsBestEffort(
  cwd: string,
  job: JobRecord,
  deps: JobWorkerDependencies
): Promise<{ changedFiles: string[] }> {
  try {
    const events = fs.existsSync(job.eventsFile)
      ? parseMimoJsonLines(fs.readFileSync(job.eventsFile, "utf8"))
      : [];
    return await captureTerminalArtifacts(cwd, events, {
      captureDiff: deps.captureDiff ?? captureGitDiff
    });
  } catch {
    return { changedFiles: [] };
  }
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

function bestEffortLog(file: string, context: PublicSummaryContext): void {
  try {
    appendJobLogLine(file, context);
  } catch {
    // The persisted job/outbox is authoritative; diagnostics must not replace the outcome.
  }
}

function bestEffortJobLog(cwd: string, jobId: string): void {
  try {
    const job = readJob(cwd, jobId);
    if (job) bestEffortLog(job.logFile, { type: "diagnostic" });
  } catch {
    // Closing an auxiliary callback server must never replace the worker result.
  }
}

function withoutRuntimeStatus(status: GitStatusSnapshot): GitStatusSnapshot {
  const fingerprints = Object.fromEntries(
    Object.entries(status.fingerprints).filter(([file]) => !isRuntimeArtifactPath(file))
  );
  const short = status.short
    .split(/\r?\n/)
    .filter((line) => !isRuntimeArtifactPath(line.replace(/^[ MADRCU?!]{2}\s+/, "")))
    .join("\n");
  return { short, dirty: Object.keys(fingerprints).length > 0, fingerprints };
}

function withoutRuntimeDiff(diff: GitDiffSnapshot): GitDiffSnapshot {
  return {
    ...diff,
    changedFiles: diff.changedFiles.filter((file) => !isRuntimeArtifactPath(file))
  };
}

function withoutRuntimeCommitChanges(changes: GitCommitChangeSnapshot): GitCommitChangeSnapshot {
  return {
    ...changes,
    changedFiles: changes.changedFiles.filter((file) => !isRuntimeArtifactPath(file))
  };
}
