import {
  bindJobDefinition,
  bootstrapWriteJobChain,
  advanceJobChainAfterChild,
  isChainOrchestratorRoot,
  preflightWriteJobAcceptance,
  type AdvanceJobChainAfterChildDependencies,
  type BoundJobDefinition,
  type JobExecutionFinalizeContext,
  type WriteChainBootstrapDependencies
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
import {
  nowIso,
  type JobRecord,
  type JobReconciliationWarning,
  type JobStatus
} from "./jobs.js";
import {
  classifyEffectiveProgress,
  classifyStallReason,
  parseProgressEventInput,
  progressIdleMs
} from "./job-progress.js";
import { publicProgressSummary, type PublicSummaryContext } from "./public-summary.js";
import {
  captureGitCommitChanges,
  captureGitDiff,
  captureGitHead,
  captureGitStatus,
  type GitCommitChangeSnapshot,
  type GitDiffSnapshot,
  type GitStatusSnapshot
} from "../git/diff.js";
import crypto from "node:crypto";
import {
  createHookCallbackController,
  toExecutionCallbackEvidence,
  type HookCallbackController
} from "../mimo/hook-callback.js";
import {
  runMimoCliStreaming,
  type StreamingRunResult,
  type TerminationReason
} from "../mimo/streaming-runner.js";
import {
  captureProcessIdentity,
  terminateOwnedJobProcess,
  type OwnedProcessTermination
} from "./job-process.js";
import { startNotificationDispatch } from "../notify/dispatch-process.js";
import { spawnNotificationWorker } from "./job-process.js";
import type { NormalizedMimoEvent } from "../compose/events.js";
import {
  extractFinalText,
  extractPassingCommandEvidence,
  extractSessionIdFromRawLine,
  extractToolNameFromRawLine,
  extractToolUseWritePaths
} from "../compose/events.js";
import {
  ProcessLockUnavailableError,
  resolveProcessLockEndpoint,
  withProcessLock
} from "./process-lock.js";
import { resolveJobWorkerOwnershipKey } from "./worker-ownership.js";
import { isRuntimeArtifactPath } from "./runtime-paths.js";
import { persistJobCheckpoint } from "./job-checkpoint.js";
import {
  captureScopedWorkspaceManifest,
  detectChangedFiles,
  fingerprintWorkspaceFiles
} from "./changed-files.js";
import {
  readExecutionEvidence,
  readExecutionEvents,
  updateExecutionEvidenceAttempts,
  writeExecutionEvidence,
  type JobExecutionEvidence
} from "./job-execution-evidence.js";

export interface JobWorkerDependencies {
  bindJobDefinition?: (job: JobRecord) => BoundJobDefinition;
  bootstrapWriteJobChain?: typeof bootstrapWriteJobChain;
  chainBootstrap?: WriteChainBootstrapDependencies;
  advanceJobChainAfterChild?: typeof advanceJobChainAfterChild;
  chainAdvance?: AdvanceJobChainAfterChildDependencies;
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
  writeCheckpoint?: (cwd: string, jobId: string, job: JobRecord) => Promise<void> | void;
  onProgressMonitorTick?: (tick: () => Promise<void>) => void;
  statusPollMs?: number;
  recoveryRetryMs?: number;
  progressMonitorPollMs?: number;
  nowMs?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

type WorkerStage = "starting" | "prompt" | "hook" | "run" | "callback" | "finalize";

const TERMINAL_STATUSES = new Set<JobStatus>([
  "needs_input",
  "blocked",
  "stalled",
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
  if (recovered && TERMINAL_STATUSES.has(recovered.job.status)) {
    await maybeAdvanceJobChainAfterChild(cwd, recovered.job, deps);
  }

  const initial = requireJob(cwd, jobId);
  if (TERMINAL_STATUSES.has(initial.status)) return;

  const transition = deps.transitionJob ?? transitionJob;
  if (initial.status === "running") {
    if (isChainOrchestratorRoot(initial)) {
      return;
    }
    const executionEvidence = initial.pid === null
      ? readExecutionEvidence(initial)
      : undefined;
    if (executionEvidence) {
      await reconcilePersistedExecution(cwd, initial, executionEvidence, deps);
      return;
    }
    const recovered = await recoverOwnedProcess(cwd, jobId, deps);
    if (!recovered) return;
    if (recovered.job.cancellationRequestedAt) {
      const cancelled = await transitionRecoverably(cwd, jobId, {
        status: "cancelled",
        summary: `Cancelled ${jobId}.`,
        errorCode: "cancelled"
      }, deps);
      await afterTerminalTransition(cwd, cancelled, deps);
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
    await afterTerminalTransition(cwd, result, deps);
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

    // Task 5/7: write roots with batchMode auto|single|sliced become orchestrators —
    // plan slices, spawn first child with null notify, skip root write MiMo.
    stage = "prompt";
    const bootstrap = await awaitWithAbort(
      (deps.bootstrapWriteJobChain ?? bootstrapWriteJobChain)(
        requireJob(cwd, jobId),
        deps.chainBootstrap ?? {},
        executionGuard.signal
      ),
      executionGuard.signal
    );
    if (bootstrap.status === "failed") {
      const failed = await transitionRecoverably(cwd, jobId, {
        status: "failed",
        summary: bootstrap.reason,
        error: bootstrap.reason,
        errorCode: bootstrap.errorCode
      }, deps);
      await afterTerminalTransition(cwd, failed, deps);
      return;
    }
    if (bootstrap.status === "bootstrapped") {
      bestEffortLog(bootstrap.root.logFile, {
        type: "job",
        status: "running",
        phase: bootstrap.root.phase
      });
      // Root stays running as orchestrator; child workers execute write slices.
      // Child terminals call advanceJobChainAfterChild via afterTerminalTransition.
      return;
    }

    if (definition.executionPolicy.writesAllowed) {
      const preflight = await preflightWriteJobAcceptance({
        cwd,
        kind: initial.kind,
        request: initial.request,
        signal: executionGuard.signal
      });
      if (!preflight.ok) {
        executionGuard.stop();
        const result = await transitionRecoverably(cwd, jobId, {
          status: "failed",
          summary: preflight.message,
          error: preflight.message,
          errorCode: "acceptance_command_unavailable",
          changedFiles: [],
          verification: [],
          failureCauses: [{
            code: "acceptance_command_unavailable",
            stage: preflight.stage,
            ...(preflight.suggestion ? { suggestion: preflight.suggestion } : {})
          }]
        }, deps);
        await afterTerminalTransition(cwd, result, deps);
        return;
      }
    }

    const prompt = await awaitWithAbort(
      definition.buildPrompt(executionGuard.signal),
      executionGuard.signal
    );
    assertJobActive(cwd, jobId, executionGuard.signal);
    const mimoArgs = definition.buildMimoArgs(prompt);
    const expectedQueryHash = crypto.createHash("sha256").update(prompt.message, "utf8").digest("hex");
    const allowedPaths = readAllowedPathsFromJobRequest(initial.request);
    const workspaceManifestBefore = captureScopedWorkspaceManifest(cwd, allowedPaths);
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
        kind: initial.kind,
        expectedQueryHash,
        ...(allowedPaths ? { allowedPaths } : {})
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
    let runSessionId: string | undefined;
    let eventSessionMismatch = false;
    let processTerminationConfirmed = false;
    let lastProgressFingerprint: string | undefined;
    let lastCheckpointAt = 0;
    const nowMs = deps.nowMs ?? (() => Date.now());
    const isoNow = () => new Date(nowMs()).toISOString();
    let progressMonitor: { stop: () => void } | undefined;
    try {
      run = await (deps.runMimoStreaming ?? runMimoCliStreaming)(cwd, mimoArgs, {
          timeoutMs: readTimeout(initial.request),
          idleTimeoutMs: readIdleTimeout(initial.request),
          env: hook.env,
          omitEnv: listWebhookSecretEnvironmentNames(cwd),
          signal: executionGuard.signal,
          onTerminationControl: ({ requestTermination }) => {
            progressMonitor = startProgressMonitor({
              cwd,
              jobId,
              deps,
              nowMs,
              isoNow,
              requestTermination
            });
          },
          onStart: async (pid) => {
            const persistProcess = deps.updateRunningJobProcess ?? updateRunningJobProcess;
            const persistObservation = deps.updateRunningJobObservation ?? updateRunningJobObservation;
            const startedAt = isoNow();
            await persistObservation(cwd, jobId, {
              lastEventAt: startedAt,
              lastActivityAt: startedAt,
              lastProgressAt: startedAt
            });
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
            const timestamp = isoNow();
            const sessionId = extractSessionIdFromRawLine(line);
            if (sessionId) {
              if (!runSessionId) {
                runSessionId = sessionId;
                hook?.bindRunSession(sessionId);
              } else if (sessionId !== runSessionId) {
                eventSessionMismatch = true;
              }
            }
            const toolName = extractToolNameFromRawLine(line);
            const event = parseProgressEventInput(line);
            let progressPatch: Parameters<typeof updateRunningJobObservation>[2] = {};
            if (event) {
              const classified = classifyEffectiveProgress({
                previousFingerprint: lastProgressFingerprint,
                event
              });
              if (classified.progressed) {
                lastProgressFingerprint = classified.fingerprint;
                progressPatch = {
                  lastProgressAt: timestamp,
                  lastProgressKind: classified.kind,
                  lastProgressFingerprint: classified.fingerprint,
                  quietSince: null,
                  ...(classified.lastCommand ? { lastCommand: classified.lastCommand } : {})
                };
                const checkpointWriter = deps.writeCheckpoint ?? defaultWriteCheckpoint;
                const checkpointNow = nowMs();
                if (checkpointNow - lastCheckpointAt >= 1_000) {
                  lastCheckpointAt = checkpointNow;
                  void Promise.resolve(checkpointWriter(cwd, jobId, {
                    ...requireJob(cwd, jobId),
                    lastProgressAt: timestamp,
                    lastProgressKind: classified.kind,
                    lastProgressFingerprint: classified.fingerprint,
                    ...(classified.lastCommand ? { lastCommand: classified.lastCommand } : {})
                  })).catch(() => undefined);
                }
              }
            }
            void persistObservation(cwd, jobId, {
              lastEventAt: timestamp,
              lastActivityAt: timestamp,
              ...(runSessionId ? { sessionId: runSessionId } : {}),
              ...(toolName ? { lastTool: toolName } : {}),
              ...progressPatch
            }).catch(() => undefined);
          }
        });
      processTerminationConfirmed = true;
    } finally {
      progressMonitor?.stop();
      if (processTerminationConfirmed) {
        await (deps.updateRunningJobProcess ?? updateRunningJobProcess)(cwd, jobId, null, null);
      }
    }
    if (run.terminationReason === "progress_timeout") {
      await waitForTerminalJobStatus(cwd, jobId, deps);
      executionGuard.stop();
      const recovered = await (deps.recoverPendingTransition ?? recoverPendingTransition)(cwd, jobId);
      if (recovered?.deliveryCreated) startNotificationWorker(cwd, recovered.job, deps);
      return;
    }
    const postRun = requireJob(cwd, jobId);
    if (TERMINAL_STATUSES.has(postRun.status)) {
      executionGuard.stop();
      const recovered = await (deps.recoverPendingTransition ?? recoverPendingTransition)(cwd, jobId);
      if (recovered?.deliveryCreated) startNotificationWorker(cwd, recovered.job, deps);
      return;
    }
    if (requireJob(cwd, jobId).cancellationRequestedAt) {
      executionGuard.stop();
      const cancelled = await transitionRecoverably(cwd, jobId, {
        status: "cancelled",
        summary: `Cancelled ${jobId}.`,
        errorCode: "cancelled"
      }, deps);
      await afterTerminalTransition(cwd, cancelled, deps);
      return;
    }
    await awaitWithAbort(eventWrites, executionGuard.signal);
    if (eventWriteError) throw eventWriteError;

    assertJobActive(cwd, jobId, executionGuard.signal);

    stage = "callback";
    const callbackSummary = await waitForExecutionCallback(hook, executionGuard.signal);
    const callbackEvidence = toExecutionCallbackEvidence(
      hook.invocationId,
      callbackSummary,
      hook.getDiagnostics()
    );
    if (eventSessionMismatch) {
      bestEffortJobLog(cwd, jobId, "JSONL event session mismatch detected.");
    }
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
    const workspaceManifestAfter = captureScopedWorkspaceManifest(cwd, allowedPaths);
    const changeDetection = detectChangedFiles({
      cwd,
      gitStatusBefore,
      gitStatusAfter,
      diff,
      commitChanges,
      manifestBefore: workspaceManifestBefore,
      manifestAfter: workspaceManifestAfter,
      toolUsePaths: extractToolUseWritePaths(events)
    });
    const finalRepositoryFingerprint = fingerprintWorkspaceFiles(
      cwd,
      [...changeDetection.files, ...changeDetection.candidates]
    );
    const commandEvidence = extractPassingCommandEvidence(events, cwd).map((evidence) => ({
      ...evidence,
      ...(evidence.afterLastWrite ? { repositoryFingerprint: finalRepositoryFingerprint } : {})
    }));
    const reconciliationWarnings: JobReconciliationWarning[] = [];
    let evidenceReportPaths: JobRecord["reportPaths"] = {};
    try {
      const saved = writeExecutionEvidence(
        requireJob(cwd, jobId),
        {
          reconciliationAttempts: 0,
          run: {
            exitCode: run.exitCode,
            ...(run.terminationReason ? { terminationReason: run.terminationReason } : {})
          },
          ...(runSessionId ? { runSessionId } : {}),
          ...(eventSessionMismatch ? { eventSessionMismatch: true as const } : {}),
          ...(callbackEvidence.failureCauses
            ? { failureCauses: callbackEvidence.failureCauses }
            : {}),
          executionCallback: callbackEvidence.executionCallback,
          gitStatusBefore,
          gitStatusAfter,
          gitHeadBefore,
          gitHeadAfter,
          diff,
          commitChanges,
          changeDetection,
          commandEvidence,
          finalRepositoryFingerprint
        },
        extractFinalText(events)
      );
      evidenceReportPaths = {
        executionEvidence: saved.evidencePath,
        ...(saved.resultPath ? { result: saved.resultPath } : {})
      };
    } catch {
      reconciliationWarnings.push({
        code: "artifact_write_failed",
        stage: "artifacts"
      });
    }
    await (deps.updateRunningJobObservation ?? updateRunningJobObservation)(cwd, jobId, {
      phase: "finalizing",
      ...(runSessionId ? { sessionId: runSessionId } : {}),
      changedFiles: changeDetection.files,
      executionCallback: callbackEvidence.executionCallback,
      reportPaths: {
        ...requireJob(cwd, jobId).reportPaths,
        ...evidenceReportPaths
      },
      reconciliation: {
        status: reconciliationWarnings.length > 0 || changeDetection.status !== "complete"
          ? "degraded"
          : "complete",
        changeDetection: {
          status: changeDetection.status,
          sources: [...changeDetection.sources],
          candidates: [...changeDetection.candidates],
          ...(changeDetection.reason ? { reason: changeDetection.reason } : {})
        },
        ...(reconciliationWarnings.length > 0
          ? { warnings: reconciliationWarnings }
          : {})
      }
    });
    assertJobActive(cwd, jobId, executionGuard.signal);
    const context: JobExecutionFinalizeContext = {
      mimoArgs,
      run,
      events,
      ...(runSessionId ? { runSessionId } : {}),
      ...(eventSessionMismatch ? { eventSessionMismatch: true } : {}),
      ...(callbackEvidence.failureCauses ? { failureCauses: callbackEvidence.failureCauses } : {}),
      executionCallback: callbackEvidence.executionCallback,
      gitStatusBefore,
      gitStatusAfter,
      gitHeadBefore,
      gitHeadAfter,
      diff,
      commitChanges,
      changeDetection,
      commandEvidence,
      finalRepositoryFingerprint,
      ...(reconciliationWarnings.length > 0
        ? { reconciliationWarnings }
        : {}),
      signal: executionGuard.signal
    };
    const outcome = await finalizeWithRetry(
      requireJob(cwd, jobId),
      definition,
      context,
      executionGuard.signal
    );

    assertJobActive(cwd, jobId, executionGuard.signal);
    executionGuard.stop();
    const { causes, ...transitionFields } = outcome;
    const durableEvidence = requireJob(cwd, jobId);
    const result = await transition(cwd, jobId, {
      ...transitionFields,
      reportPaths: {
        ...durableEvidence.reportPaths,
        ...transitionFields.reportPaths
      },
      ...(causes ? { failureCauses: causes } : {})
    });
    await afterTerminalTransition(cwd, result, deps);
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

async function finalizeWithRetry(
  job: JobRecord,
  definition: BoundJobDefinition,
  context: JobExecutionFinalizeContext,
  signal: AbortSignal
): Promise<Awaited<ReturnType<BoundJobDefinition["finalize"]>>> {
  let evidence = readExecutionEvidence(job);
  let attempts = evidence?.reconciliationAttempts ?? 0;
  let lastError: unknown;
  while (attempts < 2) {
    attempts += 1;
    if (evidence) {
      try {
        evidence = updateExecutionEvidenceAttempts(job, evidence, attempts);
      } catch {
        // The durable running job still retains changed files and callback evidence.
      }
    }
    try {
      return await awaitWithAbort(definition.finalize(context), signal);
    } catch (error) {
      signal.throwIfAborted();
      lastError = error;
    }
  }
  throw lastError ?? new Error("Reconciliation retry budget exhausted.");
}

async function reconcilePersistedExecution(
  cwd: string,
  job: JobRecord,
  evidence: JobExecutionEvidence,
  deps: JobWorkerDependencies
): Promise<void> {
  if (job.cancellationRequestedAt) {
    const cancelled = await transitionRecoverably(cwd, job.id, {
      status: "cancelled",
      summary: `Cancelled ${job.id}.`,
      errorCode: "cancelled"
    }, deps);
    await afterTerminalTransition(cwd, cancelled, deps);
    return;
  }

  const controller = new AbortController();
  const definition = (deps.bindJobDefinition ?? bindJobDefinition)(job);
  const context: JobExecutionFinalizeContext = {
    run: {
      stdout: "",
      stderr: "",
      exitCode: evidence.run.exitCode,
      pid: null,
      ...(evidence.run.terminationReason
        ? { terminationReason: evidence.run.terminationReason }
        : {})
    },
    events: readExecutionEvents(job, evidence),
    ...(evidence.runSessionId ? { runSessionId: evidence.runSessionId } : {}),
    ...(evidence.eventSessionMismatch ? { eventSessionMismatch: true } : {}),
    ...(evidence.failureCauses ? { failureCauses: evidence.failureCauses } : {}),
    ...(evidence.executionCallback
      ? { executionCallback: evidence.executionCallback }
      : {}),
    ...(evidence.gitStatusBefore ? { gitStatusBefore: evidence.gitStatusBefore } : {}),
    ...(evidence.gitStatusAfter ? { gitStatusAfter: evidence.gitStatusAfter } : {}),
    ...(evidence.gitHeadBefore ? { gitHeadBefore: evidence.gitHeadBefore } : {}),
    ...(evidence.gitHeadAfter ? { gitHeadAfter: evidence.gitHeadAfter } : {}),
    ...(evidence.diff ? { diff: evidence.diff } : {}),
    ...(evidence.commitChanges ? { commitChanges: evidence.commitChanges } : {}),
    changeDetection: evidence.changeDetection,
    commandEvidence: evidence.commandEvidence,
    finalRepositoryFingerprint: evidence.finalRepositoryFingerprint,
    signal: controller.signal
  };

  try {
    const outcome = await finalizeWithRetry(job, definition, context, controller.signal);
    const { causes, ...transitionFields } = outcome;
    const latest = requireJob(cwd, job.id);
    const result = await transitionRecoverably(cwd, job.id, {
      ...transitionFields,
      reportPaths: {
        ...latest.reportPaths,
        ...transitionFields.reportPaths
      },
      ...(causes ? { failureCauses: causes } : {})
    }, deps);
    await afterTerminalTransition(cwd, result, deps);
  } catch (error) {
    await failWorker(cwd, job.id, "finalize", error, deps);
  }
}

async function transitionRecoverably(
  cwd: string,
  jobId: string,
  request: JobTransition,
  deps: JobWorkerDependencies
): Promise<JobTransitionResult> {
  if (TERMINAL_STATUSES.has(request.status)) {
    const latest = readJob(cwd, jobId);
    if (latest) {
      const writeCheckpoint = deps.writeCheckpoint ?? defaultWriteCheckpoint;
      await writeCheckpoint(cwd, jobId, latest);
    }
  }
  try {
    return await (deps.transitionJob ?? transitionJob)(cwd, jobId, request);
  } catch (error) {
    const recovered = await (deps.recoverPendingTransition ?? recoverPendingTransition)(cwd, jobId);
    if (!recovered) throw error;
    return recovered;
  }
}

async function defaultWriteCheckpoint(
  cwd: string,
  jobId: string,
  job: JobRecord
): Promise<void> {
  await persistJobCheckpoint(cwd, job);
}

async function waitForTerminalJobStatus(
  cwd: string,
  jobId: string,
  deps: JobWorkerDependencies,
  timeoutMs = 30_000
): Promise<JobRecord> {
  const sleep = deps.sleep ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = readJob(cwd, jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (TERMINAL_STATUSES.has(job.status)) return job;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for terminal job status: ${jobId}`);
}

async function failWorker(
  cwd: string,
  jobId: string,
  stage: WorkerStage,
  error: unknown,
  deps: JobWorkerDependencies
): Promise<void> {
  let existing = requireJob(cwd, jobId);
  if (TERMINAL_STATUSES.has(existing.status)) {
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
    const cancelled = await transitionRecoverably(cwd, jobId, {
      status: "cancelled",
      summary: `Cancelled ${jobId}.`,
      errorCode: "cancelled"
    }, deps);
    await afterTerminalTransition(cwd, cancelled, deps);
    return;
  }

  if (jobDeadlineExpired(existing)) {
    const timedOut = await transitionRecoverably(cwd, jobId, {
      status: "timeout",
      summary: "MiMoCode job timed out.",
      error: "MiMoCode job timed out.",
      errorCode: "timeout"
    }, deps);
    await afterTerminalTransition(cwd, timedOut, deps);
    return;
  }

  const message = errorMessage(error);
  const executionEvidence = stage === "finalize"
    ? readExecutionEvidence(existing)
    : undefined;
  const successfulExecutionEvidence = executionEvidence?.run.exitCode === 0 &&
    executionEvidence.executionCallback?.outcome === "completed" &&
    executionEvidence.eventSessionMismatch !== true &&
    !executionEvidence.failureCauses?.length;
  if (stage === "finalize" && successfulExecutionEvidence) {
    const warnings = [
      ...(existing.reconciliation?.warnings ?? []),
      { code: "reconciliation_failed" as const, stage: "reconciliation" as const }
    ];
    const reconciled = await transitionRecoverably(cwd, jobId, {
      status: "completed",
      summary:
        "MiMoCode execution completed, but result reconciliation requires attention.",
      error: `Job reconciliation failed: ${message}`,
      errorCode: "reconciliation_failed",
      changedFiles: existing.changedFiles,
      verification: existing.verification,
      ...(existing.executionCallback
        ? { executionCallback: existing.executionCallback }
        : {}),
      ...(existing.reportPaths ? { reportPaths: existing.reportPaths } : {}),
      reconciliation: {
        status: "degraded",
        changeDetection: existing.reconciliation?.changeDetection ?? {
          status: "unavailable",
          sources: [],
          candidates: [],
          reason: "Reconciliation stopped before change detection completed."
        },
        warnings
      }
    }, deps);
    await afterTerminalTransition(cwd, reconciled, deps);
    return;
  }
  const failure: JobTransition = {
    status: "failed",
    summary: `${stageLabel(stage)}: ${message}`,
    error: `${stageLabel(stage)}: ${message}`,
    errorCode: stageErrorCode(stage)
  };
  let result: JobTransitionResult;
  try {
    result = await transitionRecoverably(cwd, jobId, failure, deps);
  } catch {
    const recovered = await (deps.recoverPendingTransition ?? recoverPendingTransition)(cwd, jobId);
    if (!recovered) throw error;
    result = recovered;
  }
  await afterTerminalTransition(cwd, result, deps);
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

async function afterTerminalTransition(
  cwd: string,
  result: JobTransitionResult,
  deps: JobWorkerDependencies
): Promise<void> {
  bestEffortLog(result.job.logFile, { type: "job", status: result.job.status });
  // Children launch with null notificationTarget — only root deliveries are enqueued.
  if (result.deliveryCreated) startNotificationWorker(cwd, result.job, deps);
  await maybeAdvanceJobChainAfterChild(cwd, result.job, deps);
}

async function maybeAdvanceJobChainAfterChild(
  cwd: string,
  job: JobRecord,
  deps: JobWorkerDependencies
): Promise<void> {
  if (!TERMINAL_STATUSES.has(job.status)) return;
  if (!job.chainId || !job.sliceId || !job.parentJobId) return;
  try {
    const advanced = await (deps.advanceJobChainAfterChild ?? advanceJobChainAfterChild)(
      { cwd, child: job },
      deps.chainAdvance ?? {}
    );
    if (advanced.ignored) return;
    if (advanced.deliveryCreated) {
      startNotificationWorker(cwd, advanced.root, deps);
    }
  } catch (error) {
    bestEffortJobLog(
      cwd,
      job.id,
      `Failed to advance job chain after child terminal: ${errorMessage(error)}`
    );
  }
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

function readTimeout(request: unknown): number {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return 1_800_000;
  const timeoutMs = (request as Record<string, unknown>).timeoutMs;
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : 1_800_000;
}

function readIdleTimeout(request: unknown): number {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return 1_800_000;
  }
  const value = (request as Record<string, unknown>).idleTimeoutMs;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value)) {
    return value;
  }
  return 1_800_000;
}

function readProgressTimeout(job: JobRecord): number {
  if (typeof job.progressTimeoutMs === "number") return job.progressTimeoutMs;
  return readNonNegativeIntFromRequest(job.request, "progressTimeoutMs", 300_000);
}

function readProgressWarning(job: JobRecord): number {
  if (typeof job.progressWarningMs === "number") return job.progressWarningMs;
  return readNonNegativeIntFromRequest(job.request, "progressWarningMs", 120_000);
}

function readNonNegativeIntFromRequest(
  request: unknown,
  field: string,
  fallback: number
): number {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return fallback;
  const value = (request as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value)
    ? value
    : fallback;
}

interface ProgressMonitorOptions {
  cwd: string;
  jobId: string;
  deps: JobWorkerDependencies;
  nowMs: () => number;
  isoNow: () => string;
  requestTermination: (reason: TerminationReason) => Promise<void>;
}

function startProgressMonitor(options: ProgressMonitorOptions): { stop: () => void } {
  const pollMs = Math.max(1, options.deps.progressMonitorPollMs ?? 1_000);
  const writeCheckpoint = options.deps.writeCheckpoint ?? defaultWriteCheckpoint;
  let stopped = false;
  let warningHandled = false;
  let timeoutHandled = false;
  let timeoutInFlight = false;

  const tick = async () => {
    if (stopped || timeoutHandled || timeoutInFlight) return;
    try {
      const job = readJob(options.cwd, options.jobId);
      if (!job || job.status !== "running") return;

      const progressTimeoutMs = readProgressTimeout(job);
      if (progressTimeoutMs <= 0) return;

      const progressWarningMs = readProgressWarning(job);
      const idle = progressIdleMs(job.lastProgressAt ?? job.startedAt, options.nowMs());
      if (idle === null) return;

      if (idle >= progressTimeoutMs) {
        timeoutInFlight = true;
        try {
          const latest = requireJob(options.cwd, options.jobId);
          const latestIdle = progressIdleMs(latest.lastProgressAt ?? latest.startedAt, options.nowMs());
          if (latest.status !== "running") {
            timeoutHandled = true;
            return;
          }
          if (latestIdle === null || latestIdle < progressTimeoutMs) return;

          await writeCheckpoint(options.cwd, options.jobId, latest);
          await options.requestTermination("progress_timeout");
          const stallErrorCode = classifyStallReasonForJob(latest, options.deps);
          const confirmed = confirmProcessTerminated(latest, options.deps);
          if (confirmed) {
            const summary = publicProgressSummary({
              type: "job",
              status: "stalled",
              errorCode: stallErrorCode
            });
            const result = await transitionRecoverably(options.cwd, options.jobId, {
              status: "stalled",
              summary,
              error: summary,
              errorCode: stallErrorCode
            }, options.deps);
            await afterTerminalTransition(options.cwd, result, options.deps);
          } else {
            const summary = publicProgressSummary({
              type: "job",
              status: "blocked",
              errorCode: "stalled_process_alive"
            });
            const result = await transitionRecoverably(options.cwd, options.jobId, {
              status: "blocked",
              summary,
              error: summary,
              errorCode: "stalled_process_alive"
            }, options.deps);
            await afterTerminalTransition(options.cwd, result, options.deps);
          }
          const after = readJob(options.cwd, options.jobId);
          if (after && after.status !== "running") timeoutHandled = true;
        } finally {
          timeoutInFlight = false;
        }
        return;
      }

      if (idle >= progressWarningMs && !warningHandled) {
        warningHandled = true;
        const latest = requireJob(options.cwd, options.jobId);
        classifyStallReasonForJob(latest, options.deps);
        const persistObservation = options.deps.updateRunningJobObservation ?? updateRunningJobObservation;
        await persistObservation(options.cwd, options.jobId, {
          quietSince: options.isoNow()
        });
      }
    } catch {
      // Progress monitoring is best-effort and must not replace the worker outcome.
    }
  };

  const timer = setInterval(() => void tick(), pollMs);
  timer.unref?.();
  options.deps.onProgressMonitorTick?.(tick);
  void tick();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    }
  };
}

function classifyStallReasonForJob(job: JobRecord, deps: JobWorkerDependencies): string {
  const processAlive = probeProcessAlive(job, deps);
  const activityAnchor = Date.parse(job.lastActivityAt ?? "");
  const progressAnchor = Date.parse(job.lastProgressAt ?? job.startedAt ?? "");
  const hasRecentActivity = Number.isFinite(activityAnchor) &&
    Number.isFinite(progressAnchor) &&
    activityAnchor > progressAnchor;
  return classifyStallReason({
    lastProgressKind: job.lastProgressKind,
    lastTool: job.lastTool,
    processAlive,
    hasRecentActivity
  });
}

function probeProcessAlive(job: JobRecord, deps: JobWorkerDependencies): boolean {
  if (job.pid === null) return false;
  const captureIdentity = deps.captureProcessIdentity ?? captureProcessIdentity;
  try {
    const probe = captureIdentity(job.pid);
    return probe.status === "running" || probe.status === "unconfirmed";
  } catch {
    return false;
  }
}

function confirmProcessTerminated(job: JobRecord, deps: JobWorkerDependencies): boolean {
  if (job.pid === null) return true;
  const terminate = deps.terminateOwnedProcess ?? terminateOwnedJobProcess;
  const captureIdentity = deps.captureProcessIdentity ?? captureProcessIdentity;
  if (job.processIdentity === null) {
    try {
      const probe = captureIdentity(job.pid);
      return probe.status === "not_running";
    } catch {
      return false;
    }
  }
  try {
    const result = terminate(job.pid, job.processIdentity);
    return result.status === "not_running" || result.status === "terminated";
  } catch {
    return false;
  }
}

function jobDeadlineExpired(job: JobRecord, now = Date.now()): boolean {
  const startedAt = Date.parse(job.startedAt ?? "");
  return Number.isFinite(startedAt) && now - startedAt >= readTimeout(job.request);
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
    finalize: "Job reconciliation failed"
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
    finalize: "reconciliation_failed"
  };
  return codes[stage];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bestEffortLog(file: string, context: PublicSummaryContext): void {
  try {
    appendJobLogLine(file, context);
  } catch {
    // The persisted job/outbox is authoritative; diagnostics must not replace the outcome.
  }
}

function bestEffortJobLog(cwd: string, jobId: string, _message: string): void {
  try {
    const job = readJob(cwd, jobId);
    if (job) bestEffortLog(job.logFile, { type: "diagnostic" });
  } catch {
    // Closing an auxiliary callback server must never replace the worker result.
  }
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function readAllowedPathsFromJobRequest(request: unknown): string[] | undefined {
  if (typeof request !== "object" || request === null || !("allowedPaths" in request)) {
    return undefined;
  }
  const value = (request as { allowedPaths?: unknown }).allowedPaths;
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return value;
}

function withoutRuntimeStatus(status: GitStatusSnapshot): GitStatusSnapshot {
  const fingerprints = Object.fromEntries(
    Object.entries(status.fingerprints).filter(([file]) => !isRuntimeArtifactPath(file))
  );
  const short = status.short
    .split(/\r?\n/)
    .filter((line) => !isRuntimeArtifactPath(line.replace(/^[ MADRCU?!]{2}\s+/, "")))
    .join("\n");
  return {
    short,
    dirty: Object.keys(fingerprints).length > 0,
    fingerprints,
    ...(status.repositoryAvailable === false ? { repositoryAvailable: false as const } : {})
  };
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
