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
  updateRunningJobPid,
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
import { spawnNotificationWorker, terminateJobProcess } from "./job-process.js";
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
  updateRunningJobPid?: typeof updateRunningJobPid;
  appendRawAndNormalizedEvent?: typeof appendRawAndNormalizedEvent;
  spawnNotificationWorker?: typeof spawnNotificationWorker;
  terminateProcessTree?: (pid: number | null) => void;
  sleep?: (milliseconds: number) => Promise<void>;
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
    try {
      (deps.terminateProcessTree ?? ((pid) => terminateJobProcess(pid)))(initial.pid ?? null);
    } catch (error) {
      bestEffortLog(initial.logFile, `Failed to terminate stale MiMoCode process: ${errorMessage(error)}`);
    }
    const failure: JobTransition = {
      status: "failed",
      summary: "A previous job worker exited while MiMoCode was still running.",
      error: "A previous job worker exited while MiMoCode was still running.",
      errorCode: "worker_restarted"
    };
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

  try {
    const definition = (deps.bindJobDefinition ?? bindJobDefinition)(initial);
    await transition(cwd, jobId, {
      status: "running",
      phase: "starting",
      summary: "Starting MiMoCode."
    });
    if (await stopForExternalTerminal(cwd, jobId, deps)) return;

    stage = "prompt";
    const prompt = await definition.buildPrompt();
    if (await stopForExternalTerminal(cwd, jobId, deps)) return;
    const mimoArgs = definition.buildMimoArgs(prompt);
    const captureStatus = deps.captureStatus ?? captureGitStatus;
    const captureHead = deps.captureHead ?? captureGitHead;
    const gitStatusBefore = withoutRuntimeStatus(await captureStatus(cwd));
    const gitHeadBefore = await captureHead(cwd);
    if (await stopForExternalTerminal(cwd, jobId, deps)) return;

    stage = "hook";
    hook = await (deps.createHookCallbackController ?? createHookCallbackController)({
      cwd,
      kind: initial.kind
    });
    if (await stopForExternalTerminal(cwd, jobId, deps)) return;

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
    const abortController = new AbortController();
    const run = await (deps.runMimoStreaming ?? runMimoCliStreaming)(cwd, mimoArgs, {
      timeoutMs: readTimeout(initial.request),
      env: hook.env,
      signal: abortController.signal,
      onStart: async (pid) => {
        const updated = await (deps.updateRunningJobPid ?? updateRunningJobPid)(cwd, jobId, pid);
        if (updated.status !== "running") abortController.abort();
      },
      onLine: (line) => queueEventWrite(async () =>
        (deps.appendRawAndNormalizedEvent ?? appendRawAndNormalizedEvent)(cwd, jobId, line))
    });
    await eventWrites;
    if (eventWriteError) throw eventWriteError;

    if (await stopForExternalTerminal(cwd, jobId, deps)) return;

    stage = "callback";
    const callbackEvidence = await waitForExecutionCallback(cwd, jobId, hook, deps);
    if (!callbackEvidence) return;
    if (await stopForExternalTerminal(cwd, jobId, deps)) return;

    stage = "finalize";
    const captureDiff = deps.captureDiff ?? captureGitDiff;
    const captureCommitChanges = deps.captureCommitChanges ?? captureGitCommitChanges;
    const gitStatusAfter = withoutRuntimeStatus(await captureStatus(cwd));
    const gitHeadAfter = await captureHead(cwd);
    const [capturedDiff, capturedCommitChanges] = await Promise.all([
      captureDiff(cwd),
      captureCommitChanges(cwd, gitHeadBefore, gitHeadAfter)
    ]);
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
      commitChanges
    };
    const outcome = await definition.finalize(context);

    if (await stopForExternalTerminal(cwd, jobId, deps)) return;
    const result = await transition(cwd, jobId, outcome);
    bestEffortLog(result.job.logFile, outcome.summary);
    if (result.deliveryCreated) startNotificationWorker(cwd, result.job, deps);
  } catch (error) {
    await eventWrites;
    await failWorker(cwd, jobId, stage, error, deps);
  } finally {
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
  cwd: string,
  jobId: string,
  hook: HookCallbackController,
  deps: JobWorkerDependencies
): Promise<ReturnType<typeof toExecutionCallbackEvidence> | undefined> {
  const callback = hook.waitForCallback().then(
    (value) => ({ type: "callback" as const, value }),
    (error: unknown) => ({ type: "error" as const, error })
  );
  const sleep = deps.sleep ?? delay;

  while (true) {
    const result = await Promise.race([
      callback,
      sleep(100).then(() => ({ type: "tick" as const }))
    ]);
    if (result.type === "callback") {
      return toExecutionCallbackEvidence(hook.invocationId, result.value);
    }
    if (result.type === "error") throw result.error;
    if (await stopForExternalTerminal(cwd, jobId, deps)) return undefined;
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

async function stopForExternalTerminal(
  cwd: string,
  jobId: string,
  deps: JobWorkerDependencies
): Promise<boolean> {
  const job = requireJob(cwd, jobId);
  if (!TERMINAL_STATUSES.has(job.status)) return false;
  const recovered = await (deps.recoverPendingTransition ?? recoverPendingTransition)(cwd, jobId);
  if (recovered?.deliveryCreated) startNotificationWorker(cwd, recovered.job, deps);
  return true;
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
