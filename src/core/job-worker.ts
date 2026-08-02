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
import {
  listWebhookSecretEnvironmentNames,
  readJob,
  updateJobAuthoritative
} from "./job-store.js";
import {
  recoverPendingTransition,
  transitionJob,
  transitionJobAfterGuardedAction,
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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createHookCallbackController,
  toExecutionCallbackEvidence,
  type HookCallbackController
} from "../mimo/hook-callback.js";
import {
  runMimoCliStreaming,
  StreamingProcessExitError,
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
  fingerprintWorkspaceFiles,
  type WorkspaceManifest
} from "./changed-files.js";
import { mergeAllowedPathScopes } from "./path-scope.js";
import {
  readExecutionEvidence,
  readExecutionEvents,
  updateExecutionEvidenceAttempts,
  updateExecutionEvidenceMergeTransaction,
  updateExecutionEvidenceWorkspace,
  writeExecutionEvidence,
  type JobExecutionEvidence
} from "./job-execution-evidence.js";
import {
  remapPromptTransportToWorkspace,
  verifyImmutablePromptAttachments
} from "../mimo/prompt-transport.js";
import {
  disposeExecutionWorkspace,
  prepareExecutionWorkspace,
  type PreparedExecutionWorkspace
} from "./execution-workspace.js";
import {
  applyWorkspacePromotion,
  createWorkspacePromotionPlan
} from "./workspace-promotion.js";
import {
  disposeGitExecutionWorkspace,
  preparePersistentGitWorktree,
  reopenPersistentGitWorktree,
  prepareGitExecutionWorkspace,
  type PersistentWorktreeLease,
  type PreparedGitExecutionWorkspace
} from "../git/worktree.js";
import {
  disposeMergeExecutionWorktree,
  defaultMergeTransactionJournalPath,
  MergePublicationUncertainError,
  prepareMergeExecutionWorktreeFromSnapshot,
  publishIntegrationBranch,
  startHostMerge,
  validateMergeTransactionJournalEvidence,
  validateAndCommitMerge,
  type PreparedMergeExecutionWorktree,
  type MergeTransactionSnapshot
} from "../git/merge-transaction.js";
import {
  createComposeReport,
  updateComposeReportMergeTransaction,
  writeComposeReport
} from "../compose/report.js";
import type { ExecutionWorkspaceLease, ExecutionWorkspaceSummary, MergeTransactionSummary, ReviewInputIntegrity } from "./jobs.js";

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

  if (await recoverPublishedMergeTransaction(cwd, initial, deps)) return;

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
  let executionWorkspace: PreparedExecutionWorkspace | PreparedGitExecutionWorkspace | PersistentWorktreeLease | undefined;
  let persistentWorktree = false;
  let executionWorkspaceRetained = false;
  let executionWorkspaceDisposed = false;
  let mergePrepared: PreparedMergeExecutionWorktree | undefined;
  let mergeRetained = false;

  try {
    let definition = (deps.bindJobDefinition ?? bindJobDefinition)(initial);
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
        errorCode: bootstrap.errorCode,
        failureCauses: [{
          code: bootstrap.errorCode,
          stage: "prompt",
          suggestion: bootstrap.reason
        }]
      }, deps);
      await afterTerminalTransition(cwd, failed, deps);
      return;
    }
    if (bootstrap.status === "needs_input") {
      const needsInput = await transitionRecoverably(cwd, jobId, {
        status: "needs_input",
        summary: bootstrap.reason,
        error: bootstrap.reason,
        errorCode: bootstrap.errorCode,
        acceptance: { stages: [] }
      }, deps);
      await afterTerminalTransition(cwd, needsInput, deps);
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
        if (preflight.code === "acceptance_config_missing") {
          const result = await transitionRecoverably(cwd, jobId, {
            status: "needs_input",
            summary: preflight.message,
            error: preflight.message,
            errorCode: preflight.code,
            changedFiles: [],
            verification: [],
            acceptance: { stages: [] }
          }, deps);
          await afterTerminalTransition(cwd, result, deps);
          return;
        }
        const result = await transitionRecoverably(cwd, jobId, {
          status: "failed",
          summary: preflight.message,
          error: preflight.message,
          errorCode: preflight.code,
          changedFiles: [],
          verification: [],
          failureCauses: [{
            code: preflight.code,
            stage: preflight.stage ?? "build",
            ...(preflight.suggestion ? { suggestion: preflight.suggestion } : {})
          }]
        }, deps);
        await afterTerminalTransition(cwd, result, deps);
        return;
      }
    }

    const controlPrompt = await awaitWithAbort(
      definition.buildPrompt(executionGuard.signal),
      executionGuard.signal
    );
    assertJobActive(cwd, jobId, executionGuard.signal);
    let executionCwd = cwd;
    let prompt = controlPrompt;
    if (usesMergeWorkflow(initial.request) && !deps.bindJobDefinition) {
      const snapshot = readMergeSnapshot(initial.request);
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-merge-"));
      try {
        mergePrepared = prepareMergeExecutionWorktreeFromSnapshot(snapshot, {
          jobId: initial.id,
          executionRoot: path.join(parent, "workspace")
        });
      } catch (error) {
        try { fs.rmdirSync(parent); } catch { /* preserve merge failure */ }
        throw error;
      }
      executionCwd = mergePrepared.executionRoot;
      const preparedSummary = mergeTransactionSummary(mergePrepared, "prepared");
      await updateJobAuthoritative(cwd, jobId, {
        executionWorkspace: mergeExecutionWorkspaceSummary(mergePrepared, "prepared"),
        mergeTransaction: preparedSummary
      });
      prompt = remapPromptTransportToWorkspace(controlPrompt, { controlRoot: cwd, executionRoot: executionCwd });
      definition = bindJobDefinition(initial, { runtimeCwd: executionCwd });
    } else if ((usesWorktreeWorkflow(initial.request) || initial.executionWorkspaceLease !== undefined) && !deps.bindJobDefinition) {
      persistentWorktree = true;
      const storedLease = initial.executionWorkspaceLease;
      executionWorkspace = storedLease
        ? reopenPersistentGitWorktree(storedLease)
        : preparePersistentGitWorktree(cwd, initial.id);
      if (!storedLease) {
        await updateJobAuthoritative(cwd, jobId, { executionWorkspaceLease: toPersistentLease(executionWorkspace) });
      }
      executionCwd = executionWorkspace.executionRoot;
      await updateJobAuthoritative(cwd, jobId, { executionWorkspace: executionWorkspaceSummary(executionWorkspace, "retained") });
      prompt = remapPromptTransportToWorkspace(controlPrompt, { controlRoot: cwd, executionRoot: executionCwd });
      if (!deps.bindJobDefinition) definition = bindJobDefinition(initial, { runtimeCwd: executionCwd });
    } else if (shouldUseExecutionIsolation(initial, definition, deps)) {
      executionWorkspace = prepareOwnedExecutionWorkspace(cwd);
      executionCwd = executionWorkspace.executionRoot;
      await updateJobAuthoritative(cwd, jobId, {
        executionWorkspace: executionWorkspaceSummary(executionWorkspace, "prepared")
      });
      prompt = remapPromptTransportToWorkspace(controlPrompt, {
        controlRoot: cwd,
        executionRoot: executionCwd
      });
      // Test doubles intentionally retain their already-bound behavior. Real
      // definitions are rebound so build args and finalization execute here.
      if (!deps.bindJobDefinition) {
        definition = bindJobDefinition(initial, { runtimeCwd: executionCwd });
      }
    }
    let reviewInput: ReviewInputIntegrity | undefined;
    if (prompt.immutableAttachments?.length) {
      const beforeRun = verifyImmutablePromptAttachments(prompt);
      reviewInput = {
        attachments: prompt.immutableAttachments,
        status: beforeRun.ok ? "verified_before_run" : "modified"
      };
      await updateJobAuthoritative(cwd, jobId, { reviewInput });
      if (!beforeRun.ok) {
        executionGuard.stop();
        const result = await transitionRecoverably(cwd, jobId, {
          status: "failed",
          summary: "MiMoCode review input integrity verification failed before execution.",
          error: "The frozen review diff attachment was modified or is unavailable.",
          errorCode: "review_attachment_modified",
          failureCauses: [{ code: "review_attachment_modified", stage: "prompt" }]
        }, deps);
        await afterTerminalTransition(cwd, result, deps);
        return;
      }
    }
    const mimoArgs = definition.buildMimoArgs(prompt);
    const expectedQueryHash = crypto.createHash("sha256").update(prompt.message, "utf8").digest("hex");
    const allowedPaths = readAllowedPathsFromJobRequest(initial.request);
    const artifactPaths = readArtifactPathsFromJobRequest(initial.request);
    const monitoredPaths = mergeAllowedPathScopes(allowedPaths, artifactPaths);
    const workspaceManifestBefore = captureScopedWorkspaceManifest(executionCwd, monitoredPaths);
    const captureStatus = deps.captureStatus ?? captureGitStatus;
    const captureHead = deps.captureHead ?? captureGitHead;
    const gitStatusBefore = withoutRuntimeStatus(
      await awaitWithAbort(
        captureStatus(executionCwd, { signal: executionGuard.signal }),
        executionGuard.signal
      )
    );
    assertJobActive(cwd, jobId, executionGuard.signal);
    const gitHeadBefore = await awaitWithAbort(
      captureHead(executionCwd, { signal: executionGuard.signal }),
      executionGuard.signal
    );
    assertJobActive(cwd, jobId, executionGuard.signal);
    if (mergePrepared) {
      const hostMerge = startHostMerge(mergePrepared);
      if (hostMerge.status === "already_integrated") {
        const summary = mergeTransactionSummary(mergePrepared, "already_integrated");
        const noOpReportPaths = writeAlreadyIntegratedMergeArtifacts(
          cwd,
          requireJob(cwd, jobId),
          summary,
          gitStatusBefore,
          gitHeadBefore
        );
        try {
          disposeMergeExecutionWorktree(mergePrepared);
          await updateJobAuthoritative(cwd, jobId, {
            executionWorkspace: mergeExecutionWorkspaceSummary(mergePrepared, "disposed"),
            mergeTransaction: summary
          });
        } catch (error) {
          mergeRetained = true;
          await updateJobAuthoritative(cwd, jobId, {
            executionWorkspace: mergeExecutionWorkspaceSummary(mergePrepared, "retained", errorMessage(error)),
            mergeTransaction: summary
          });
        }
        executionGuard.stop();
        const result = await transitionRecoverably(cwd, jobId, {
          status: "completed",
          summary: "Source branch is already integrated into the pinned target; no merge was published.",
          changedFiles: [],
          verification: [],
          ...(Object.keys(noOpReportPaths).length ? { reportPaths: noOpReportPaths } : {})
        }, deps);
        await afterTerminalTransition(cwd, result, deps);
        return;
      }
    }
    if (workspaceManifestBefore && !executionWorkspace) {
      try {
        await persistJobCheckpoint(cwd, requireJob(cwd, jobId), {
          workspaceManifestBefore,
          captureHead: async () => gitHeadBefore,
          captureStatus: async () => gitStatusBefore
        });
      } catch (error) {
        bestEffortJobLog(
          cwd,
          jobId,
          `Failed to persist the pre-run workspace manifest: ${errorMessage(error)}`
        );
      }
    }

    stage = "hook";
    hook = await awaitWithAbort(
      (deps.createHookCallbackController ?? createHookCallbackController)({
        cwd: executionCwd,
        kind: initial.kind,
        expectedQueryHash,
        ...(allowedPaths ? { allowedPaths } : {}),
        // Bridge-owned worktrees run under executionCwd; external directories are never granted.
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
      run = await (deps.runMimoStreaming ?? runMimoCliStreaming)(executionCwd, mimoArgs, {
          timeoutMs: readTimeout(initial.request),
          idleTimeoutMs: readIdleTimeout(initial.request),
          env: hook.env,
          omitEnv: listWebhookSecretEnvironmentNames(cwd),
          signal: executionGuard.signal,
          onTerminationControl: ({ requestTermination }) => {
            progressMonitor = startProgressMonitor({
              cwd,
              executionCwd,
              jobId,
              deps,
              nowMs,
              isoNow,
              gitStatusBefore,
              workspaceManifestBefore,
              monitoredPaths,
              requestTermination,
              getReceivedCallbackEvidence: () => receivedCallbackEvidence(hook)
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
    const skipCallbackWait = shouldSkipCallbackWait(run.terminationReason);
    if (skipCallbackWait) {
      bestEffortJobLog(
        cwd,
        jobId,
        `Skipped session.post wait after ${run.terminationReason}; late or missing callback is diagnostic only.`
      );
    }
    const callbackSummary = skipCallbackWait
      ? hook.getReceivedCallback()
      : await waitForExecutionCallback(hook, executionGuard.signal);
    const callbackEvidence = callbackSummary
      ? toExecutionCallbackEvidence(
        hook.invocationId,
        callbackSummary,
        hook.getDiagnostics()
      )
      : undefined;
    const callbackFailureCauses = callbackEvidence?.failureCauses;
    const executionCallback = callbackEvidence?.executionCallback;
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
        captureStatus(executionCwd, { signal: executionGuard.signal }),
        executionGuard.signal
      )
    );
    assertJobActive(cwd, jobId, executionGuard.signal);
    const gitHeadAfter = await awaitWithAbort(
      captureHead(executionCwd, { signal: executionGuard.signal }),
      executionGuard.signal
    );
    assertJobActive(cwd, jobId, executionGuard.signal);
    const capturedDiff = await awaitWithAbort(
      captureDiff(executionCwd, "HEAD", { signal: executionGuard.signal }),
      executionGuard.signal
    );
    assertJobActive(cwd, jobId, executionGuard.signal);
    const capturedCommitChanges = await awaitWithAbort(
      captureCommitChanges(executionCwd, gitHeadBefore, gitHeadAfter, { signal: executionGuard.signal }),
      executionGuard.signal
    );
    assertJobActive(cwd, jobId, executionGuard.signal);
    const diff = withoutRuntimeDiff(capturedDiff);
    const commitChanges = withoutRuntimeCommitChanges(capturedCommitChanges);
    const workspaceManifestAfter = captureScopedWorkspaceManifest(executionCwd, monitoredPaths);
    const changeDetection = detectChangedFiles({
      cwd: executionCwd,
      gitStatusBefore,
      gitStatusAfter,
      diff,
      commitChanges,
      manifestBefore: workspaceManifestBefore,
      manifestAfter: workspaceManifestAfter,
      toolUsePaths: extractToolUseWritePaths(events),
      artifactPaths
    });
    const finalRepositoryFingerprint = fingerprintWorkspaceFiles(
      executionCwd,
      [...changeDetection.files, ...changeDetection.artifactFiles, ...changeDetection.candidates]
    );
    const commandEvidence = extractPassingCommandEvidence(events, executionCwd).map((evidence) => ({
      ...evidence,
      ...(evidence.afterLastWrite ? { repositoryFingerprint: finalRepositoryFingerprint } : {})
    }));
    const reconciliationWarnings: JobReconciliationWarning[] = [];
    const afterRunAttachmentVerification = reviewInput
      ? verifyImmutablePromptAttachments(prompt)
      : undefined;
    if (reviewInput && afterRunAttachmentVerification) {
      reviewInput = {
        ...reviewInput,
        status: afterRunAttachmentVerification.ok ? "verified" : "modified"
      };
      await updateJobAuthoritative(cwd, jobId, { reviewInput });
    }
    const reviewAttachmentFailure = afterRunAttachmentVerification && !afterRunAttachmentVerification.ok
      ? { code: "review_attachment_modified", stage: "prompt" as const }
      : undefined;
    let evidenceReportPaths: JobRecord["reportPaths"] = {};
    let executionEvidence: JobExecutionEvidence | undefined;
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
          ...(callbackFailureCauses
            ? { failureCauses: callbackFailureCauses }
            : {}),
          ...(executionCallback ? { executionCallback } : {}),
          ...(reviewInput ? { reviewInput } : {}),
          ...(executionWorkspace ? {
            executionWorkspace: executionWorkspaceSummary(executionWorkspace, "prepared")
          } : {}),
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
      executionEvidence = saved.evidence;
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
    const persistWorkspaceEvidence = (summary: ExecutionWorkspaceSummary): void => {
      if (!executionEvidence) return;
      try {
        executionEvidence = updateExecutionEvidenceWorkspace(
          requireJob(cwd, jobId),
          executionEvidence,
          summary
        );
      } catch {
        // The job record remains the authoritative audit record.
      }
    };
    const persistMergeEvidence = (
      summary: MergeTransactionSummary,
      terminal?: Parameters<typeof updateComposeReportMergeTransaction>[2]
    ): void => {
      if (executionEvidence) {
        try {
          executionEvidence = updateExecutionEvidenceMergeTransaction(
            requireJob(cwd, jobId), executionEvidence, summary,
            terminal ? {
              status: terminal.status === "timeout" ? "timeout" : terminal.status === "passed" ? "completed" : "failed",
              ...(terminal.errorCode ? { errorCode: terminal.errorCode } : {}),
              ...(terminal.gitHeadAfter ? { gitHeadAfter: terminal.gitHeadAfter } : {}),
              ...(terminal.gitCommits ? { gitCommits: terminal.gitCommits } : {})
            } : undefined
          );
        } catch {
          // Job metadata remains authoritative if the auxiliary evidence write fails.
        }
      }
      try {
        updateComposeReportMergeTransaction(requireJob(cwd, jobId).reportPaths?.json, summary, terminal);
      } catch {
        // Report augmentation is best-effort and must not replace the transaction outcome.
      }
    };
    await (deps.updateRunningJobObservation ?? updateRunningJobObservation)(cwd, jobId, {
      phase: "finalizing",
      ...(runSessionId ? { sessionId: runSessionId } : {}),
      changedFiles: changeDetection.files,
      ...(changeDetection.artifactFiles.length
        ? { artifactFiles: changeDetection.artifactFiles }
        : {}),
      ...(executionCallback ? { executionCallback } : {}),
      ...(reviewInput ? { reviewInput } : {}),
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
      ...(callbackFailureCauses || reviewAttachmentFailure
        ? { failureCauses: [
            ...(callbackFailureCauses ?? []),
            ...(reviewAttachmentFailure ? [reviewAttachmentFailure] : [])
          ] }
        : {}),
      ...(executionCallback ? { executionCallback } : {}),
      gitStatusBefore,
      gitStatusAfter,
      gitHeadBefore,
      gitHeadAfter,
      diff,
      commitChanges,
      changeDetection,
      commandEvidence,
      finalRepositoryFingerprint,
      controlCwd: cwd,
      executionCwd,
      ...(reconciliationWarnings.length > 0
        ? { reconciliationWarnings }
        : {}),
      signal: executionGuard.signal
    };
    if (reviewAttachmentFailure) {
      executionGuard.stop();
      const result = await transitionRecoverably(cwd, jobId, {
        status: "failed",
        summary: "MiMoCode review input changed during execution; the review was rejected.",
        error: "The frozen review diff attachment no longer matched its SHA-256.",
        errorCode: "review_attachment_modified",
        ...(executionCallback ? { executionCallback } : {}),
        ...(evidenceReportPaths.executionEvidence
          ? { reportPaths: {
              ...requireJob(cwd, jobId).reportPaths,
              ...evidenceReportPaths
            } }
          : {}),
        failureCauses: [reviewAttachmentFailure]
      }, deps);
      await afterTerminalTransition(cwd, result, deps);
      return;
    }
    let outcome = await finalizeWithRetry(
      requireJob(cwd, jobId),
      definition,
      context,
      executionGuard.signal
    );

    if (run.terminationReason === "host_abort" && skipCallbackWait) {
      outcome = {
        ...outcome,
        status: "failed",
        summary: "MiMoCode execution failed.",
        error: "MiMoCode run was aborted by the host.",
        errorCode: "mimo_exit_nonzero",
        ...(executionCallback ? { executionCallback } : {})
      };
    }

    if (executionWorkspace && gitHeadBefore.oid !== gitHeadAfter.oid) {
      executionWorkspaceRetained = true;
      const summary = executionWorkspaceSummary(
        executionWorkspace,
        "retained",
        undefined,
        undefined,
        "MiMoCode created a Git commit in the isolated execution workspace."
      );
      await updateJobAuthoritative(cwd, jobId, { executionWorkspace: summary });
      persistWorkspaceEvidence(summary);
      const commitCause = { code: "commit_not_allowed", stage: "diff_check" as const };
      outcome = {
        ...outcome,
        status: outcome.status === "cancelled" || outcome.status === "timeout"
          ? outcome.status
          : "failed",
        summary: "MiMoCode created a Git commit in the isolated execution workspace.",
        error: "Write jobs must leave changes uncommitted so the bridge can validate and promote them safely.",
        errorCode: "commit_not_allowed",
        causes: [commitCause, ...(outcome.causes ?? [])]
      };
    }

    let committedMerge: ReturnType<typeof validateAndCommitMerge> | undefined;
    if (mergePrepared && outcome.status === "completed") {
      try {
        committedMerge = validateAndCommitMerge({
          prepared: mergePrepared,
          allowedPaths: allowedPaths ?? [],
          // The host owns this commit and must remain non-interactive even in
          // a fresh repository without user.name/user.email configured.
          author: { name: "Codex MiMo Bridge", email: "codex-mimo@local" }
        });
        const summary = {
            ...mergeTransactionSummary(mergePrepared, "merged"),
            mergeOid: committedMerge.mergeOid,
            // Persist before guarded publication. A crash in the next narrow
            // window can recover this path and prove whether CAS ran.
            journalPath: defaultMergeTransactionJournalPath(mergePrepared)
          };
        await updateJobAuthoritative(cwd, jobId, { mergeTransaction: summary });
        persistMergeEvidence(summary);
        outcome = { ...outcome, changedFiles: committedMerge.changedFiles };
      } catch (error) {
        mergeRetained = true;
        const reason = errorMessage(error);
        const summary = mergeTransactionSummary(mergePrepared, "retained");
        await updateJobAuthoritative(cwd, jobId, {
          executionWorkspace: mergeExecutionWorkspaceSummary(mergePrepared, "retained", reason),
          mergeTransaction: summary
        });
        persistMergeEvidence(summary);
        outcome = {
          ...outcome,
          status: "failed",
          summary: "Merge transaction validation failed; the execution worktree was retained.",
          error: reason,
          errorCode: "merge_validation_failed",
          causes: [{ code: "merge_validation_failed", stage: "diff_check" }, ...(outcome.causes ?? [])]
        };
      }
    }

    let promotionPlan: ReturnType<typeof createWorkspacePromotionPlan> | undefined;
    if (executionWorkspace && outcome.status === "completed") {
      promotionPlan = createWorkspacePromotionPlan({
        baseline: executionWorkspace.baseline,
        executionRoot: executionCwd,
        // An absent user scope keeps the existing unrestricted-write contract;
        // runtime directories are excluded by the workspace manifest itself.
        allowedPaths,
        artifactPaths
      });
      if (!promotionPlan.passed) {
        executionWorkspaceRetained = true;
        persistWorkspaceEvidence(executionWorkspaceSummary(
          executionWorkspace,
          "retained",
          undefined,
          undefined,
          promotionPlan.reason
        ));
        outcome = {
          ...outcome,
          status: "failed",
          summary: promotionPlan.reason ?? "Execution changes failed promotion scope validation.",
          error: promotionPlan.reason ?? "Execution changes failed promotion scope validation.",
          errorCode: promotionPlan.failureCode === "promotion_scope_violation"
            ? "write_scope_violation"
            : "promotion_apply_failed",
          causes: [{
            code: promotionPlan.failureCode ?? "promotion_apply_failed",
            stage: "scope_check"
          }]
        };
      }
    }
    // A persistent Compose worktree is deliberately never promoted. The pure
    // promotion plan above remains the final scope audit.
    if (persistentWorktree && promotionPlan?.passed) {
      executionWorkspaceRetained = true;
      persistWorkspaceEvidence(executionWorkspaceSummary(executionWorkspace!, "retained"));
    }
    if (mergePrepared && outcome.status !== "completed" && !mergeRetained) {
      mergeRetained = true;
      const existing = requireJob(cwd, jobId).mergeTransaction;
      const summary: MergeTransactionSummary = {
        ...(existing ?? mergeTransactionSummary(mergePrepared, "retained")),
        status: "retained"
      };
      await updateJobAuthoritative(cwd, jobId, {
        executionWorkspace: mergeExecutionWorkspaceSummary(
          mergePrepared,
          "retained",
          outcome.error ?? outcome.summary
        ),
        mergeTransaction: summary
      });
      persistMergeEvidence(summary);
    }
    if (executionWorkspace && outcome.status !== "completed" && !executionWorkspaceRetained) {
      executionWorkspaceRetained = true;
      await updateJobAuthoritative(cwd, jobId, {
        executionWorkspace: executionWorkspaceSummary(executionWorkspace, "retained")
      });
      persistWorkspaceEvidence(executionWorkspaceSummary(executionWorkspace, "retained"));
    }

    assertJobActive(cwd, jobId, executionGuard.signal);
    executionGuard.stop();
    const { causes, ...transitionFields } = outcome;
    const durableEvidence = requireJob(cwd, jobId);
    const completedTransition = {
      ...transitionFields,
      reportPaths: {
        ...durableEvidence.reportPaths,
        ...transitionFields.reportPaths
      },
      ...(causes ? { failureCauses: causes } : {})
    };
    let result: JobTransitionResult;
    if (mergePrepared && committedMerge && outcome.status === "completed" && !deps.transitionJob) {
      try {
        result = await transitionJobAfterGuardedAction(cwd, jobId, completedTransition, () => {
          const published = publishIntegrationBranch({ prepared: mergePrepared!, merge: committedMerge! });
          return {
            mergeTransaction: {
              ...mergeTransactionSummary(mergePrepared!, "published"),
              mergeOid: committedMerge!.mergeOid,
              integrationRef: published.integrationRef,
              journalPath: published.journalPath
            }
          };
        });
      } catch (error) {
        const uncertainJournalPath = error instanceof MergePublicationUncertainError
          ? error.journalPath
          : undefined;
        const uncertain = uncertainJournalPath
          ? validateMergeTransactionJournalEvidence(cwd, uncertainJournalPath)
          : undefined;
        if (uncertain?.publication === "published") {
          const summary = {
            ...mergeTransactionSummary(mergePrepared, "published"),
            mergeOid: committedMerge.mergeOid,
            integrationRef: uncertain.journal.integrationRef,
            journalPath: uncertainJournalPath
          };
          await updateJobAuthoritative(cwd, jobId, { mergeTransaction: summary });
          persistMergeEvidence(summary);
          result = await transition(cwd, jobId, completedTransition);
        } else {
          mergeRetained = true;
          const reason = uncertain?.reason ?? errorMessage(error);
          const summary = { ...mergeTransactionSummary(mergePrepared, "retained"), mergeOid: committedMerge.mergeOid,
            ...(error instanceof MergePublicationUncertainError ? { journalPath: error.journalPath } : {}) };
        await updateJobAuthoritative(cwd, jobId, {
          executionWorkspace: mergeExecutionWorkspaceSummary(mergePrepared, "retained", reason),
          mergeTransaction: summary
        });
        persistMergeEvidence(summary);
        result = await transition(cwd, jobId, {
          ...completedTransition,
          status: "failed",
          summary: "Merge integration branch was not published; the execution worktree was retained.",
          error: reason,
          errorCode: "merge_publish_failed",
          failureCauses: [{ code: "merge_publish_failed", stage: "execution" }]
        });
        }
      }
    } else if (executionWorkspace && !persistentWorktree && promotionPlan?.passed && outcome.status === "completed" && !deps.transitionJob) {
      try {
        result = await transitionJobAfterGuardedAction(cwd, jobId, completedTransition, () => {
          const applied = applyWorkspacePromotion({
            controlRoot: cwd,
            executionRoot: executionCwd,
            baseline: executionWorkspace!.baseline,
            plan: promotionPlan!
          });
          if (!applied.passed) throw new PromotionApplyError(applied);
          const summary = executionWorkspaceSummary(executionWorkspace!, "promoted", applied.journalPath);
          persistWorkspaceEvidence(summary);
          return { executionWorkspace: summary };
        });
      } catch (error) {
        if (!(error instanceof PromotionApplyError)) throw error;
        executionWorkspaceRetained = true;
        const conflict = error.applied.failureCode === "promotion_conflict";
        const summary = executionWorkspaceSummary(
          executionWorkspace,
          "retained",
          error.applied.journalPath,
          error.applied.conflictPaths,
          error.applied.reason
        );
        persistWorkspaceEvidence(summary);
        result = await transition(cwd, jobId, {
          ...completedTransition,
          status: conflict ? "needs_input" : "failed",
          summary: error.applied.reason ?? "Execution changes could not be promoted.",
          error: error.applied.reason ?? "Execution changes could not be promoted.",
          errorCode: error.applied.failureCode ?? "promotion_apply_failed",
          failureCauses: [{
            code: error.applied.failureCode ?? "promotion_apply_failed",
            stage: conflict ? "scope_check" : "execution"
          }],
          reportPaths: {
            ...completedTransition.reportPaths,
            ...requireJob(cwd, jobId).reportPaths
          },
          // The normal transition owns lifecycle; persist retained metadata
          // before it when a test-injected transition implementation is used.
        });
        await updateJobAuthoritative(cwd, jobId, { executionWorkspace: summary });
      }
    } else {
      result = await transition(cwd, jobId, completedTransition);
    }
    if (executionWorkspace && !persistentWorktree && !executionWorkspaceRetained && result.job.status === "completed") {
      try {
        await persistJobCheckpoint(cwd, result.job, {
          changedFiles: outcome.changedFiles ?? changeDetection.files,
          sourceCwd: cwd
        });
      } catch (error) {
        bestEffortJobLog(cwd, jobId, `Failed to refresh the promoted checkpoint: ${errorMessage(error)}`);
      }
    }
    if (mergePrepared && result.job.status === "completed" && !mergeRetained) {
      try {
        disposeMergeExecutionWorktree(mergePrepared);
        const current = requireJob(cwd, jobId).mergeTransaction;
        await updateJobAuthoritative(cwd, jobId, {
          executionWorkspace: mergeExecutionWorkspaceSummary(mergePrepared, "disposed"),
          ...(current ? { mergeTransaction: current } : {})
        });
      } catch (error) {
        mergeRetained = true;
        await updateJobAuthoritative(cwd, jobId, {
          executionWorkspace: mergeExecutionWorkspaceSummary(mergePrepared, "retained", errorMessage(error))
        });
      }
    }
    if (mergePrepared) {
      const summary = requireJob(cwd, jobId).mergeTransaction;
      if (summary) {
        // Successful merge worktrees are disposed before this audit hook. The
        // host-verified merge OID is therefore the only trustworthy final HEAD.
        const terminalHead = summary.mergeOid
          ? { oid: summary.mergeOid, short: summary.mergeOid.slice(0, 12), subject: "Bridge-created merge commit" }
          : await captureHead(executionCwd).catch(() => undefined);
        const terminalStatus = result.job.status === "timeout"
          ? "timeout" as const
          : result.job.status === "completed"
            ? "passed" as const
            : "failed" as const;
        persistMergeEvidence(summary, {
          status: terminalStatus,
          ...(result.job.errorCode ? { errorCode: result.job.errorCode } : {}),
          ...(result.job.changedFiles.length ? { changedFiles: result.job.changedFiles } : {}),
          ...(terminalHead ? { gitHeadAfter: terminalHead } : {}),
          ...(summary.mergeOid ? { gitCommits: [summary.mergeOid] } : {})
        });
      }
    }
    if (executionWorkspace && persistentWorktree && result.job.status === "completed") {
      try {
        await persistJobCheckpoint(cwd, result.job, {
          changedFiles: outcome.changedFiles ?? changeDetection.files,
          sourceCwd: executionCwd
        });
      } catch (error) {
        bestEffortJobLog(cwd, jobId, `Failed to persist persistent-worktree checkpoint: ${errorMessage(error)}`);
      }
    }
    if (executionWorkspace && !persistentWorktree && !executionWorkspaceRetained && result.job.status === "completed") {
      try {
        disposeOwnedExecutionWorkspace(executionWorkspace);
        executionWorkspaceDisposed = true;
        await updateJobAuthoritative(cwd, jobId, {
          executionWorkspace: executionWorkspaceSummary(executionWorkspace, "disposed")
        });
      } catch (error) {
        executionWorkspaceRetained = true;
        await updateJobAuthoritative(cwd, jobId, {
          executionWorkspace: executionWorkspaceSummary(
            executionWorkspace,
            "retained",
            undefined,
            undefined,
            `Promotion completed, but workspace cleanup was retained: ${errorMessage(error)}`
          )
        });
      }
    }
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
    if (error instanceof StreamingProcessExitError) {
      await (deps.updateRunningJobProcess ?? updateRunningJobProcess)(cwd, jobId, null, null);
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
    if (executionWorkspace && !executionWorkspaceDisposed && !executionWorkspaceRetained) {
      try {
        await updateJobAuthoritative(cwd, jobId, {
          executionWorkspace: executionWorkspaceSummary(executionWorkspace, "retained")
        });
      } catch {
        // The failure transition remains authoritative if the audit patch cannot persist.
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

function receivedCallbackEvidence(
  hook: HookCallbackController | undefined
): ReturnType<typeof toExecutionCallbackEvidence> | undefined {
  const callback = hook?.getReceivedCallback();
  if (!hook || !callback) return undefined;
  return toExecutionCallbackEvidence(hook.invocationId, callback, hook.getDiagnostics());
}

function shouldSkipCallbackWait(reason: TerminationReason | undefined): boolean {
  return reason === "process_timeout" ||
    reason === "idle_timeout" ||
    reason === "progress_timeout" ||
    reason === "user_cancelled" ||
    reason === "host_abort";
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
  if (job.executionWorkspace) {
    const result = await transitionRecoverably(cwd, job.id, {
      status: "needs_input",
      summary: "The isolated execution workspace was retained after an interrupted worker and requires review before recovery.",
      error: "Automatic reconciliation never promotes or completes an interrupted isolated execution workspace.",
      errorCode: "isolation_recovery_required"
    }, deps);
    await afterTerminalTransition(cwd, result, deps);
    return;
  }

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
  if (evidence.reviewInput?.status === "modified") {
    const result = await transitionRecoverably(cwd, job.id, {
      status: "failed",
      summary: "MiMoCode review input changed during execution; the review was rejected.",
      error: "The frozen review diff attachment no longer matched its SHA-256.",
      errorCode: "review_attachment_modified",
      ...(evidence.executionCallback ? { executionCallback: evidence.executionCallback } : {}),
      ...(job.reportPaths ? { reportPaths: job.reportPaths } : {}),
      failureCauses: [{ code: "review_attachment_modified", stage: "prompt" }]
    }, deps);
    await afterTerminalTransition(cwd, result, deps);
    return;
  }
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
    ...(evidence.reviewInput ? { reviewInput: evidence.reviewInput } : {}),
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
  executionCwd?: string;
  jobId: string;
  deps: JobWorkerDependencies;
  nowMs: () => number;
  isoNow: () => string;
  gitStatusBefore: GitStatusSnapshot;
  workspaceManifestBefore?: WorkspaceManifest;
  monitoredPaths?: string[];
  requestTermination: (reason: TerminationReason) => Promise<void>;
  getReceivedCallbackEvidence?: () => ReturnType<typeof toExecutionCallbackEvidence> | undefined;
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

          await options.requestTermination("progress_timeout");
          const stallErrorCode = classifyStallReasonForJob(latest, options.deps);
          const confirmed = confirmProcessTerminated(latest, options.deps);
          const reconciled = await reconcileStalledJob(options, latest);
          const callbackEvidence = options.getReceivedCallbackEvidence?.();
          await writeCheckpoint(options.cwd, options.jobId, reconciled);
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
              errorCode: stallErrorCode,
              changedFiles: reconciled.changedFiles,
              ...(callbackEvidence?.failureCauses
                ? { failureCauses: callbackEvidence.failureCauses }
                : {}),
              ...(callbackEvidence?.executionCallback
                ? { executionCallback: callbackEvidence.executionCallback }
                : {}),
              ...(reconciled.reconciliation
                ? { reconciliation: reconciled.reconciliation }
                : {})
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
              errorCode: "stalled_process_alive",
              changedFiles: reconciled.changedFiles,
              ...(callbackEvidence?.failureCauses
                ? { failureCauses: callbackEvidence.failureCauses }
                : {}),
              ...(callbackEvidence?.executionCallback
                ? { executionCallback: callbackEvidence.executionCallback }
                : {}),
              ...(reconciled.reconciliation
                ? { reconciliation: reconciled.reconciliation }
                : {})
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

async function reconcileStalledJob(
  options: ProgressMonitorOptions,
  job: JobRecord
): Promise<JobRecord> {
  try {
    const captureStatus = options.deps.captureStatus ?? captureGitStatus;
    const gitStatusAfter = withoutRuntimeStatus(await captureStatus(options.executionCwd ?? options.cwd));
    const workspaceManifestAfter = captureScopedWorkspaceManifest(
      options.executionCwd ?? options.cwd,
      options.monitoredPaths
    );
    const changeDetection = detectChangedFiles({
      cwd: options.executionCwd ?? options.cwd,
      gitStatusBefore: options.gitStatusBefore,
      gitStatusAfter,
      manifestBefore: options.workspaceManifestBefore,
      manifestAfter: workspaceManifestAfter,
      artifactPaths: readArtifactPathsFromJobRequest(job.request)
    });
    return {
      ...job,
      changedFiles: changeDetection.files,
      ...(changeDetection.artifactFiles.length
        ? { artifactFiles: changeDetection.artifactFiles }
        : {}),
      reconciliation: {
        status: changeDetection.status === "complete" ? "complete" : "degraded",
        changeDetection: {
          status: changeDetection.status,
          sources: [...changeDetection.sources],
          candidates: [...changeDetection.candidates],
          ...(changeDetection.reason ? { reason: changeDetection.reason } : {})
        }
      }
    };
  } catch {
    return job;
  }
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

function shouldUseExecutionIsolation(
  job: JobRecord,
  definition: BoundJobDefinition,
  deps: JobWorkerDependencies
): boolean {
  // Dependency-injected definitions are deterministic worker-test harnesses;
  // their simulated writes intentionally target the supplied control cwd.
  if (deps.bindJobDefinition) return false;
  if (!definition.executionPolicy.writesAllowed) return false;
  return !usesWorktreeWorkflow(job.request) && !usesMergeWorkflow(job.request);
}

class PromotionApplyError extends Error {
  constructor(readonly applied: ReturnType<typeof applyWorkspacePromotion>) {
    super(applied.reason ?? "Execution changes could not be promoted.");
  }
}

function usesMergeWorkflow(request: unknown): boolean {
  if (typeof request !== "object" || request === null) return false;
  const record = request as { workflow?: unknown; checkpoint?: { workflow?: unknown } };
  return record.workflow === "merge" || record.checkpoint?.workflow === "merge";
}

/**
 * A process can stop after the create-only ref CAS but before its terminal
 * transition is durable. The journal is the authority in that narrow window;
 * never rerun MiMoCode or attempt a second CAS.
 */
async function recoverPublishedMergeTransaction(
  cwd: string,
  job: JobRecord,
  deps: JobWorkerDependencies
): Promise<boolean> {
  if (!usesMergeWorkflow(job.request) ||
      (job.mergeTransaction?.status !== "published" && job.mergeTransaction?.status !== "merged") ||
      !job.mergeTransaction.journalPath) return false;
  let evidence: ReturnType<typeof validateMergeTransactionJournalEvidence> | undefined;
  try {
    evidence = validateMergeTransactionJournalEvidence(cwd, job.mergeTransaction.journalPath);
  } catch {
    // A merged transaction without a readable journal was interrupted before
    // publication could be proven; retain it rather than rerunning MiMoCode.
  }
  if (evidence?.publication !== "published") {
    await updateJobAuthoritative(cwd, job.id, {
      executionWorkspace: job.executionWorkspace
        ? { ...job.executionWorkspace, status: "retained", reason: evidence?.reason ?? "Merge publication recovery requires review." }
        : undefined,
      mergeTransaction: { ...job.mergeTransaction, status: "retained" }
    });
    const retained = await transitionRecoverably(cwd, job.id, {
      status: "failed",
      summary: "Published-merge recovery evidence is inconsistent; the transaction was retained for review.",
      error: evidence?.reason ?? "Merge publication journal did not prove the integration ref.",
      errorCode: "merge_publication_recovery_required",
      failureCauses: [{ code: "merge_publication_recovery_required", stage: "execution" }]
    }, deps);
    await afterTerminalTransition(cwd, retained, deps);
    return true;
  }
  if (job.status === "queued") {
    await (deps.transitionJob ?? transitionJob)(cwd, job.id, {
      status: "running", phase: "finalizing", summary: "Recovering published merge transaction."
    });
  }
  const publishedSummary: MergeTransactionSummary = {
    ...job.mergeTransaction,
    status: "published",
    ...(evidence.journal.mergeOid ? { mergeOid: evidence.journal.mergeOid } : {}),
    ...(evidence.journal.integrationRef ? { integrationRef: evidence.journal.integrationRef } : {}),
    journalPath: job.mergeTransaction.journalPath
  };
  await updateJobAuthoritative(cwd, job.id, { mergeTransaction: publishedSummary });
  const current = requireJob(cwd, job.id);
  try {
    const execution = readExecutionEvidence(current);
    if (execution) updateExecutionEvidenceMergeTransaction(current, execution, publishedSummary);
    updateComposeReportMergeTransaction(current.reportPaths?.json, publishedSummary);
  } catch {
    // The durable job record and journal remain authoritative.
  }
  const completed = await transitionRecoverably(cwd, job.id, {
    status: "completed",
    summary: "Recovered a previously published merge integration branch.",
    changedFiles: current.changedFiles,
    verification: current.verification,
    ...(current.reportPaths ? { reportPaths: current.reportPaths } : {})
  }, deps);
  try {
    updateComposeReportMergeTransaction(current.reportPaths?.json, publishedSummary);
  } catch {
    // A durable job state and journal evidence are sufficient for recovery.
  }
  await afterTerminalTransition(cwd, completed, deps);
  return true;
}

function writeAlreadyIntegratedMergeArtifacts(
  cwd: string,
  job: JobRecord,
  mergeTransaction: MergeTransactionSummary,
  gitStatus: GitStatusSnapshot,
  gitHead: Awaited<ReturnType<typeof captureGitHead>>
): NonNullable<JobRecord["reportPaths"]> {
  const reportDir = path.join(cwd, ".codex-mimo", "reports");
  const eventsDir = path.join(cwd, ".codex-mimo", "events");
  const diffsDir = path.join(cwd, ".codex-mimo", "diffs");
  const diff = { changedFiles: [], diffStat: "", diff: "" };
  const finalText = "Source branch was already integrated into the pinned target. No MiMoCode run, merge commit, or integration branch was created.";
  try {
    const report = createComposeReport({
      id: job.id,
      createdAt: job.createdAt,
      workflow: "merge",
      cwd,
      requestedSkills: ["compose:merge"],
      status: "passed",
      events: [],
      diff,
      gitStatusBefore: gitStatus,
      gitStatusAfter: gitStatus,
      gitHeadBefore: gitHead,
      gitHeadAfter: gitHead,
      verification: [],
      reportDir,
      eventsDir,
      diffsDir,
      mergeTransaction
    });
    writeComposeReport(report);
    const execution = writeExecutionEvidence(job, {
      reconciliationAttempts: 0,
      run: { exitCode: 0 },
      gitStatusBefore: gitStatus,
      gitStatusAfter: gitStatus,
      gitHeadBefore: gitHead,
      gitHeadAfter: gitHead,
      diff,
      changeDetection: { files: [], artifactFiles: [], candidates: [], status: "complete", sources: [] },
      commandEvidence: [],
      finalRepositoryFingerprint: "",
      mergeTransaction
    }, finalText);
    return {
      json: report.reportPaths.json,
      markdown: report.reportPaths.markdown,
      eventsJsonl: report.reportPaths.eventsJsonl,
      executionEvidence: execution.evidencePath,
      ...(execution.resultPath ? { result: execution.resultPath } : {})
    };
  } catch {
    return {};
  }
}

function readMergeSnapshot(request: unknown): MergeTransactionSnapshot {
  if (typeof request !== "object" || request === null) {
    throw new Error("Merge transaction is missing its pinned launch snapshot.");
  }
  const snapshot = (request as { mergeSnapshot?: unknown }).mergeSnapshot;
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("Merge transaction is missing its pinned launch snapshot.");
  }
  const value = snapshot as Partial<MergeTransactionSnapshot>;
  if (typeof value.controlRoot !== "string" || typeof value.sourceRef !== "string" ||
      typeof value.targetRef !== "string" || typeof value.sourceOid !== "string" ||
      typeof value.targetOid !== "string" || !value.workspace || !Array.isArray(value.worktrees)) {
    throw new Error("Merge transaction launch snapshot is invalid.");
  }
  return value as MergeTransactionSnapshot;
}

function mergeTransactionSummary(
  prepared: PreparedMergeExecutionWorktree,
  status: MergeTransactionSummary["status"]
): MergeTransactionSummary {
  return {
    transactionId: prepared.transactionId,
    sourceRef: prepared.snapshot.sourceRef,
    targetRef: prepared.snapshot.targetRef,
    sourceOid: prepared.snapshot.sourceOid,
    targetOid: prepared.snapshot.targetOid,
    status
  };
}

function mergeExecutionWorkspaceSummary(
  prepared: PreparedMergeExecutionWorktree,
  status: ExecutionWorkspaceSummary["status"],
  reason?: string
): ExecutionWorkspaceSummary {
  return {
    path: prepared.executionRoot,
    kind: "git_worktree",
    status,
    isolationGuarantee: "cwd_relative_write_containment",
    ...(reason ? { reason } : {})
  };
}

function prepareOwnedExecutionWorkspace(
  controlRoot: string
): PreparedExecutionWorkspace | PreparedGitExecutionWorkspace {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-execution-"));
  const executionRoot = path.join(temporaryRoot, "workspace");
  try {
    if (fs.existsSync(path.join(controlRoot, ".git"))) {
      return prepareGitExecutionWorkspace(controlRoot, executionRoot);
    }
    return prepareExecutionWorkspace({ sourceRoot: controlRoot, executionRoot });
  } catch (error) {
    // The parent is created solely for this attempt and contains no user
    // workspace. Remove it only while it is still directly under the system
    // temp directory with our fixed prefix.
    if (path.basename(temporaryRoot).startsWith("codex-mimo-execution-")) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

function disposeOwnedExecutionWorkspace(
  workspace: PreparedExecutionWorkspace | PreparedGitExecutionWorkspace
): void {
  if (isGitExecutionWorkspace(workspace)) {
    disposeGitExecutionWorkspace(workspace);
  } else {
    disposeExecutionWorkspace(workspace as PreparedExecutionWorkspace);
  }
  const parent = path.dirname(workspace.executionRoot);
  if (path.basename(parent).startsWith("codex-mimo-execution-") && fs.existsSync(parent)) {
    try {
      fs.rmdirSync(parent);
    } catch {
      // Diagnostics remain readable if an unexpected file was left behind.
    }
  }
}

function executionWorkspaceSummary(
  workspace: PreparedExecutionWorkspace | PreparedGitExecutionWorkspace | PersistentWorktreeLease,
  status: ExecutionWorkspaceSummary["status"],
  journalPath?: string,
  conflictPaths?: string[],
  reason?: string
): ExecutionWorkspaceSummary {
  return {
    path: workspace.executionRoot,
    kind: isGitExecutionWorkspace(workspace) ? "git_worktree" : "copy",
    status,
    // This is deliberately not an OS sandbox: an agent can still issue an
    // explicit absolute-path write under the same user identity.
    isolationGuarantee: "cwd_relative_write_containment",
    ...(journalPath ? { journalPath } : {}),
    ...(conflictPaths && conflictPaths.length > 0 ? { conflictPaths } : {}),
    ...(reason ? { reason } : {}),
    ...(isPersistentWorktreeLease(workspace)
      ? { mode: "persistent" as const, branch: workspace.branch, resumable: true as const }
      : {})
  };
}

function toPersistentLease(workspace: PreparedExecutionWorkspace | PreparedGitExecutionWorkspace | PersistentWorktreeLease): ExecutionWorkspaceLease {
  if (!isPersistentWorktreeLease(workspace)) throw new Error("Persistent worktree lease expected.");
  return { mode: "persistent", jobId: workspace.jobId, controlRoot: workspace.controlRoot,
    executionRoot: workspace.executionRoot, ownerMetadataPath: workspace.ownerMetadataPath,
    ownerToken: workspace.ownerToken, branch: workspace.branch, createdAt: workspace.createdAt };
}

function isGitExecutionWorkspace(
  workspace: PreparedExecutionWorkspace | PreparedGitExecutionWorkspace | PersistentWorktreeLease
): workspace is PreparedGitExecutionWorkspace {
  return "controlRoot" in workspace;
}

function isPersistentWorktreeLease(
  workspace: PreparedExecutionWorkspace | PreparedGitExecutionWorkspace | PersistentWorktreeLease
): workspace is PersistentWorktreeLease {
  return "mode" in workspace && workspace.mode === "persistent";
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

function usesWorktreeWorkflow(request: unknown): boolean {
  if (typeof request !== "object" || request === null) return false;
  const record = request as {
    workflow?: unknown;
    checkpoint?: { workflow?: unknown };
  };
  return record.workflow === "worktree" || record.checkpoint?.workflow === "worktree";
}

function readArtifactPathsFromJobRequest(request: unknown): string[] | undefined {
  if (typeof request !== "object" || request === null || !("acceptance" in request)) {
    return undefined;
  }
  const acceptance = (request as { acceptance?: unknown }).acceptance;
  if (typeof acceptance !== "object" || acceptance === null || !("artifactPaths" in acceptance)) {
    return undefined;
  }
  const value = (acceptance as { artifactPaths?: unknown }).artifactPaths;
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
