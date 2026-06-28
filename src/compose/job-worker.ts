import { buildMimoRunArgs } from "../mimo/run-json.js";
import {
  captureGitCommitChanges,
  captureGitDiff,
  type GitCommitChangeSnapshot,
  type GitDiffSnapshot,
  captureGitHead,
  type GitHeadSnapshot,
  captureGitStatus,
  type GitStatusSnapshot
} from "../git/diff.js";
import { parseMimoJsonLines } from "./events.js";
import { normalizeVerificationCommands, runVerificationCommands, type VerificationResult } from "./verify.js";
import { buildComposePrompt, getComposeWorkflow, type ComposeWorkflowName } from "./workflow.js";
import { buildComposeReportFromRun, timeoutError } from "./runner.js";
import { writeComposeReport } from "./report.js";
import { runMimoCliStreaming, type StreamingRunResult } from "./streaming-runner.js";
import { appendRuntimeEvent, completeRuntimeJob, failRuntimeJob, startRuntimeJob } from "../core/job-runtime.js";
import { readJob, updateJob } from "../core/job-store.js";
import { isActiveJobStatus, type JobCallbackSummary } from "../core/jobs.js";
import { preparePromptTransport } from "../mimo/prompt-transport.js";
import {
  createHookCallbackController,
  type HookCallbackController,
  type MimoHookCallbackSummary
} from "../mimo/hook-callback.js";
import {
  detectSemanticFailure,
  detectReadOnlyViolationFiles,
  buildReadOnlyReportDiff,
  detectNewFilesFromStatus
} from "./post-checks.js";

interface ComposeWorkerRequest {
  cwd: string;
  workflow: ComposeWorkflowName;
  task?: string;
  file?: string;
  since?: string;
  model?: string;
  attach?: string;
  session?: string;
  fork?: boolean;
  continue?: boolean;
  verification?: string[];
  reportDir?: string;
  timeoutMs?: number;
}

interface ComposeWorkerDeps {
  runMimoStreaming?: typeof runMimoCliStreaming;
  captureDiff?: (cwd: string, base?: string) => Promise<GitDiffSnapshot>;
  captureStatus?: (cwd: string) => Promise<GitStatusSnapshot>;
  captureHead?: (cwd: string) => Promise<GitHeadSnapshot>;
  captureCommitChanges?: (cwd: string, before?: GitHeadSnapshot, after?: GitHeadSnapshot) => Promise<GitCommitChangeSnapshot>;
  runVerification?: (cwd: string, commands: string[]) => Promise<VerificationResult[]>;
  createHookCallbackController?: typeof createHookCallbackController;
  now?: () => Date;
}

function jobReportPaths(report: { reportPaths: { json: string; markdown: string; eventsJsonl: string }; diffPath?: string }) {
  return {
    json: report.reportPaths.json,
    markdown: report.reportPaths.markdown,
    eventsJsonl: report.reportPaths.eventsJsonl,
    diff: report.diffPath
  };
}

export async function runComposeJobWorker(cwd: string, jobId: string, deps: ComposeWorkerDeps = {}): Promise<void> {
  const job = readJob(cwd, jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }
  const input = job.request as ComposeWorkerRequest;
  const workflow = getComposeWorkflow(input.workflow);
  const prompt = buildComposePrompt({
    workflow,
    task: input.task,
    file: input.file,
    since: input.since
  });
  const transportedPrompt = preparePromptTransport(prompt, { cwd: input.cwd });
  const mimoArgs = buildMimoRunArgs({
    cwd: input.cwd,
    agent: "compose",
    model: input.model,
    message: transportedPrompt.message,
    title: `codex-mimo compose ${workflow.name}`,
    session: input.session,
    fork: input.fork,
    attach: input.attach,
    files: [...transportedPrompt.files, ...(input.file ? [input.file] : [])],
    continue: input.continue
  });
  const now = deps.now ?? (() => new Date());
  const createdAt = job.createdAt;
  const reportDir = input.reportDir ?? `${input.cwd}/.codex-mimo/reports`;
  const eventsDir = `${input.cwd}/.codex-mimo/events`;
  const diffsDir = `${input.cwd}/.codex-mimo/diffs`;
  const captureStatus = deps.captureStatus ?? captureGitStatus;
  const captureDiff = deps.captureDiff ?? captureGitDiff;
  const captureHead = deps.captureHead ?? captureGitHead;
  const captureCommitChanges = deps.captureCommitChanges ?? captureGitCommitChanges;
  const runVerification = deps.runVerification ?? runVerificationCommands;

  startRuntimeJob(cwd, jobId);

  let gitStatusBefore: GitStatusSnapshot | undefined;
  try {
    gitStatusBefore = await captureStatus(input.cwd);
  } catch {
    // Git status capture is best-effort.
  }
  let gitHeadBefore: GitHeadSnapshot | undefined;
  try {
    gitHeadBefore = await captureHead(input.cwd);
  } catch {
    // Git HEAD capture is best-effort.
  }

  let runResult: StreamingRunResult;
  let hook: HookCallbackController | null = null;
  let callbackSummary: JobCallbackSummary | undefined;
  try {
    hook = await createComposeWorkerHook(input.cwd, `compose-${workflow.name}`, deps);
    runResult = await (deps.runMimoStreaming ?? runMimoCliStreaming)(input.cwd, mimoArgs, {
      timeoutMs: input.timeoutMs,
      env: hook.env,
      onStart: (pid) => recordActiveJobPid(cwd, jobId, pid),
      onLine: (line) => appendRuntimeEvent(cwd, jobId, line)
    });
    updateJob(cwd, jobId, {
      phase: "finalizing",
      summary: "Waiting for MiMoCode completion callback."
    });
    callbackSummary = toJobCallbackSummary(hook.invocationId, await hook.waitForCallback());
  } catch (error) {
    if (hook && !callbackSummary) {
      callbackSummary = {
        invocationId: hook.invocationId,
        outcome: "missing",
        error: missingCallbackError()
      };
    }
    failRuntimeJob(cwd, jobId, {
      errorCode: "startup_failed",
      error: error instanceof Error ? error.message : String(error),
      callback: callbackSummary
    });
    return;
  } finally {
    await hook?.close();
  }

  let diff: GitDiffSnapshot = { changedFiles: [], diffStat: "", diff: "" };
  let gitStatusAfter: GitStatusSnapshot | undefined;
  let gitHeadAfter: GitHeadSnapshot | undefined;
  let gitCommitChanges: GitCommitChangeSnapshot = { commits: [], changedFiles: [] };
  let verification: VerificationResult[] = [];
  const callbackError = jobCallbackFailureMessage(callbackSummary);
  const callbackErrorCode = jobCallbackFailureCode(callbackSummary);

  try {
    diff = await captureDiff(input.cwd, input.since ?? "HEAD");
  } catch (error) {
    failWithReport({
      errorCode: callbackErrorCode ?? "diff_capture_failed",
      error: callbackError ?? `Git diff capture failed: ${error instanceof Error ? error.message : String(error)}`
    });
    return;
  }

  try {
    gitStatusAfter = await captureStatus(input.cwd);
  } catch (error) {
    failWithReport({
      errorCode: callbackErrorCode ?? "status_capture_failed",
      error: callbackError ?? `Git status capture failed: ${error instanceof Error ? error.message : String(error)}`
    });
    return;
  }

  try {
    gitHeadAfter = await captureHead(input.cwd);
  } catch {
    // Git HEAD capture is best-effort.
  }

  try {
    gitCommitChanges = await captureCommitChanges(input.cwd, gitHeadBefore, gitHeadAfter);
  } catch {
    // Commit range capture is best-effort once HEAD movement is known.
  }

  try {
    verification = await runVerification(input.cwd, normalizeVerificationCommands(input.verification, workflow.defaultVerification, input.cwd));
  } catch (error) {
    failWithReport({
      errorCode: callbackErrorCode ?? "verification_failed",
      error: callbackError ?? `Verification execution failed: ${error instanceof Error ? error.message : String(error)}`
    });
    return;
  }

  const readOnlyViolationFiles = detectReadOnlyViolationFiles(
    workflow.writesAllowed,
    diff.changedFiles,
    gitStatusBefore,
    gitStatusAfter
  );
  const readOnlyChangedFiles = workflow.writesAllowed
    ? []
    : mergeUnique(readOnlyViolationFiles, gitCommitChanges.changedFiles);
  let reportDiff = workflow.writesAllowed ? diff : buildReadOnlyReportDiff(diff, readOnlyChangedFiles);
  if (workflow.writesAllowed && gitCommitChanges.changedFiles.length > 0) {
    reportDiff = { ...reportDiff, changedFiles: mergeUnique(reportDiff.changedFiles, gitCommitChanges.changedFiles) };
  }
  if (workflow.writesAllowed && gitStatusBefore && gitStatusAfter) {
    const statusNewFiles = detectNewFilesFromStatus(gitStatusBefore, gitStatusAfter);
    if (statusNewFiles.length > 0) {
      reportDiff = { ...reportDiff, changedFiles: mergeUnique(reportDiff.changedFiles, statusNewFiles) };
    }
  }

  if (!workflow.writesAllowed && (readOnlyChangedFiles.length > 0 || gitHeadChanged(gitHeadBefore, gitHeadAfter))) {
    const report = buildComposeReportFromRun({
      id: jobId,
      createdAt,
      input,
      mimoArgs,
      requestedSkills: workflow.skillChain,
      eventsStdout: runResult.stdout,
      diff: reportDiff,
      verification,
      reportDir,
      eventsDir,
      diffsDir,
      status: "failed",
      gitStatusBefore,
      gitStatusAfter,
      gitHeadBefore,
      gitHeadAfter,
      gitCommits: gitCommitChanges.commits,
      callback: fromJobCallbackSummary(callbackSummary),
      callbackTimedOut: callbackSummary?.outcome === "missing",
      error: readOnlyViolationError(workflow.name, readOnlyChangedFiles, gitHeadBefore, gitHeadAfter, callbackError)
    });
    writeComposeReport(report);
    failRuntimeJob(cwd, jobId, {
      errorCode: callbackErrorCode ?? "read_only_violation",
      error: report.error ?? "Compose post-processing failed.",
      sessionId: report.sessionId ?? input.session ?? null,
      changedFiles: report.changedFiles,
      reportPaths: jobReportPaths(report),
      callback: callbackSummary
    });
    return;
  }

  const semanticFailure = detectSemanticFailure(runResult.stdout);
  if (semanticFailure) {
    const report = buildComposeReportFromRun({
      id: job.id,
      createdAt,
      input,
      mimoArgs,
      requestedSkills: workflow.skillChain,
      eventsStdout: runResult.stdout,
      diff: reportDiff,
      verification,
      reportDir,
      eventsDir,
      diffsDir,
      status: "failed",
      gitStatusBefore,
      gitStatusAfter,
      gitHeadBefore,
      gitHeadAfter,
      gitCommits: gitCommitChanges.commits,
      callback: fromJobCallbackSummary(callbackSummary),
      callbackTimedOut: callbackSummary?.outcome === "missing",
      error: callbackError ?? semanticFailure
    });
    writeComposeReport(report);
    failRuntimeJob(cwd, jobId, {
      errorCode: callbackErrorCode ?? "semantic_failure",
      error: report.error ?? "MiMoCode failed.",
      sessionId: report.sessionId ?? input.session ?? null,
      reportPaths: jobReportPaths(report),
      callback: callbackSummary
    });
    return;
  }

  const status = runResult.exitCode === 124
    ? "timeout"
    : callbackError
    ? "failed"
    : runResult.exitCode === 0 && verification.every((item) => item.passed)
    ? (verification.length === 0 && reportDiff.changedFiles.length > 0 ? "needs_review" : "passed")
    : "failed";
  const report = buildComposeReportFromRun({
    id: job.id,
    createdAt,
    input,
    mimoArgs,
    requestedSkills: workflow.skillChain,
    eventsStdout: runResult.stdout,
    diff: reportDiff,
    verification,
    reportDir,
    eventsDir,
    diffsDir,
    status,
    gitStatusBefore,
    gitStatusAfter,
    gitHeadBefore,
    gitHeadAfter,
    gitCommits: gitCommitChanges.commits,
    callback: fromJobCallbackSummary(callbackSummary),
    callbackTimedOut: callbackSummary?.outcome === "missing",
    error: (status === "timeout" ? timeoutError(runResult.terminationReason) : undefined)
      ?? callbackError
      ?? (status === "failed" ? (runResult.stderr || `MiMoCode exited ${runResult.exitCode}`) : undefined)
  });
  writeComposeReport(report);

  if (status === "failed" || status === "timeout") {
    failRuntimeJob(cwd, jobId, {
      errorCode: runResult.exitCode === 124 ? "timeout" : (callbackErrorCode ?? "nonzero_exit"),
      error: report.error ?? "MiMoCode failed.",
      sessionId: report.sessionId ?? input.session ?? null,
      reportPaths: jobReportPaths(report),
      callback: callbackSummary
    });
    return;
  }

  completeRuntimeJob(cwd, jobId, {
    summary: `${report.workflow} ${report.status}; ${report.changedFiles.length} changed files.`,
    sessionId: report.sessionId ?? input.session ?? null,
    changedFiles: report.changedFiles,
    verification: report.verification,
    reportPaths: jobReportPaths(report),
    callback: callbackSummary
  });

  function failWithReport(failure: { errorCode: string; error: string }): void {
    const report = buildComposeReportFromRun({
      id: jobId,
      createdAt,
      input,
      mimoArgs,
      requestedSkills: workflow.skillChain,
      eventsStdout: runResult.stdout,
      diff,
      verification,
      reportDir,
      eventsDir,
      diffsDir,
      status: "failed",
      gitStatusBefore,
      gitStatusAfter,
      gitHeadBefore,
      gitHeadAfter,
      gitCommits: gitCommitChanges.commits,
      callback: fromJobCallbackSummary(callbackSummary),
      callbackTimedOut: callbackSummary?.outcome === "missing",
      error: failure.error
    });
    writeComposeReport(report);
    failRuntimeJob(cwd, jobId, {
      errorCode: failure.errorCode,
      error: report.error ?? failure.error,
      sessionId: report.sessionId ?? input.session ?? null,
      changedFiles: report.changedFiles,
      reportPaths: jobReportPaths(report),
      callback: callbackSummary
    });
  }
}

function recordActiveJobPid(cwd: string, jobId: string, pid: number | null): void {
  const job = readJob(cwd, jobId);
  if (!job || !isActiveJobStatus(job.status)) return;
  updateJob(cwd, jobId, { pid });
}

async function createComposeWorkerHook(
  cwd: string,
  kind: string,
  deps: ComposeWorkerDeps
): Promise<HookCallbackController> {
  const createHook = deps.createHookCallbackController ?? createHookCallbackController;
  return createHook({ cwd, kind });
}

function toJobCallbackSummary(invocationId: string, callback: MimoHookCallbackSummary | null): JobCallbackSummary {
  if (!callback) {
    return {
      invocationId,
      outcome: "missing",
      error: missingCallbackError()
    };
  }
  return {
    invocationId: callback.invocationId,
    outcome: callback.outcome ?? "error",
    sessionId: callback.sessionId ?? null,
    receivedAt: callback.receivedAt,
    error: callback.error
  };
}

function fromJobCallbackSummary(callback?: JobCallbackSummary): MimoHookCallbackSummary | null | undefined {
  if (!callback || callback.outcome === "missing") return callback ? null : undefined;
  return {
    invocationId: callback.invocationId,
    event: "session.post",
    outcome: callback.outcome,
    sessionId: callback.sessionId ?? undefined,
    receivedAt: callback.receivedAt ?? new Date().toISOString(),
    error: callback.error
  };
}

function jobCallbackFailureMessage(callback?: JobCallbackSummary): string | undefined {
  if (!callback) return undefined;
  if (callback.outcome === "missing") return callback.error ?? missingCallbackError();
  if (callback.outcome === "error" || callback.outcome === "cancelled") {
    return callback.error ?? `MiMoCode completion callback reported ${callback.outcome}.`;
  }
  return undefined;
}

function jobCallbackFailureCode(callback?: JobCallbackSummary): string | undefined {
  if (!callback) return undefined;
  if (callback.outcome === "missing") return "callback_missing";
  if (callback.outcome === "error") return "callback_error";
  if (callback.outcome === "cancelled") return "callback_cancelled";
  return undefined;
}

function missingCallbackError(): string {
  return "MiMoCode exited before codex-mimo received session.post.";
}

function readOnlyViolationError(
  workflowName: string,
  files: string[],
  before?: GitHeadSnapshot,
  after?: GitHeadSnapshot,
  callbackError?: string
): string {
  const parts: string[] = [];
  if (gitHeadChanged(before, after)) {
    parts.push(`Read-only workflow ${workflowName} changed HEAD from ${formatHeadShort(before)} to ${formatHeadShort(after)}.`);
  }
  if (files.length > 0) {
    parts.push(`Read-only workflow ${workflowName} modified files: ${files.join(", ")}`);
  }
  if (callbackError) {
    parts.push(callbackError);
  }
  return parts.join(" Also: ");
}

function gitHeadChanged(before?: GitHeadSnapshot, after?: GitHeadSnapshot): boolean {
  return Boolean(before && after && before.oid !== after.oid);
}

function formatHeadShort(head?: GitHeadSnapshot): string {
  return head?.short || "unknown";
}

function mergeUnique(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}
