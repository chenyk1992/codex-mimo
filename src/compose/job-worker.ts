import { buildMimoRunArgs } from "../mimo/run-json.js";
import { captureGitDiff, type GitDiffSnapshot } from "../git/diff.js";
import { captureGitStatus, type GitStatusSnapshot } from "../git/status.js";
import { normalizeVerificationCommands, runVerificationCommands, type VerificationResult } from "./verify.js";
import { buildComposePrompt, getComposeWorkflow, type ComposeWorkflowName } from "./workflow.js";
import { buildComposeReportFromRun } from "./runner.js";
import { writeComposeReport } from "./report.js";
import { runMimoCliStreaming, type StreamingRunResult } from "./streaming-runner.js";
import { appendRuntimeEvent, completeRuntimeJob, failRuntimeJob, startRuntimeJob } from "../core/job-runtime.js";
import { readJob, updateJob } from "../core/job-store.js";

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
  runVerification?: (cwd: string, commands: string[]) => Promise<VerificationResult[]>;
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
  const mimoArgs = buildMimoRunArgs({
    cwd: input.cwd,
    agent: "compose",
    model: input.model,
    message: prompt,
    title: `codex-mimo compose ${workflow.name}`,
    session: input.session,
    fork: input.fork,
    attach: input.attach,
    files: input.file ? [input.file] : [],
    continue: input.continue
  });
  const now = deps.now ?? (() => new Date());
  const createdAt = job.createdAt;
  const reportDir = input.reportDir ?? `${input.cwd}/.codex-mimo/reports`;
  const eventsDir = `${input.cwd}/.codex-mimo/events`;
  const diffsDir = `${input.cwd}/.codex-mimo/diffs`;

  startRuntimeJob(cwd, jobId);

  let runResult: StreamingRunResult;
  try {
    runResult = await (deps.runMimoStreaming ?? runMimoCliStreaming)(input.cwd, mimoArgs, {
      timeoutMs: input.timeoutMs,
      onLine: (line) => appendRuntimeEvent(cwd, jobId, line)
    });
    updateJob(cwd, jobId, { pid: runResult.pid });
  } catch (error) {
    failRuntimeJob(cwd, jobId, {
      errorCode: "startup_failed",
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  const captureStatus = deps.captureStatus ?? captureGitStatus;
  const captureDiff = deps.captureDiff ?? captureGitDiff;
  const runVerification = deps.runVerification ?? runVerificationCommands;
  const gitStatusBefore = undefined;
  let diff: GitDiffSnapshot = { changedFiles: [], diffStat: "", diff: "" };
  let gitStatusAfter: GitStatusSnapshot | undefined;
  let verification: VerificationResult[] = [];

  try {
    diff = await captureDiff(input.cwd, input.since ?? "HEAD");
    gitStatusAfter = await captureStatus(input.cwd);
    verification = await runVerification(input.cwd, normalizeVerificationCommands(input.verification, workflow.defaultVerification));
  } catch (error) {
    const report = buildComposeReportFromRun({
      id: job.id,
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
      error: error instanceof Error ? error.message : String(error)
    });
    writeComposeReport(report);
    failRuntimeJob(cwd, jobId, {
      errorCode: "report_write_failed",
      error: report.error ?? "Compose post-processing failed.",
      reportPaths: jobReportPaths(report)
    });
    return;
  }

  const status = runResult.exitCode === 0 && verification.every((item) => item.passed)
    ? (verification.length === 0 && diff.changedFiles.length > 0 ? "needs_review" : "passed")
    : "failed";
  const report = buildComposeReportFromRun({
    id: job.id,
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
    status,
    gitStatusBefore,
    gitStatusAfter,
    error: status === "failed" ? runResult.stderr || `MiMoCode exited ${runResult.exitCode}` : undefined
  });
  writeComposeReport(report);

  if (status === "failed") {
    failRuntimeJob(cwd, jobId, {
      errorCode: runResult.exitCode === 124 ? "timeout" : "nonzero_exit",
      error: report.error ?? "MiMoCode failed.",
      reportPaths: jobReportPaths(report)
    });
    return;
  }

  completeRuntimeJob(cwd, jobId, {
    summary: `${report.workflow} ${report.status}; ${report.changedFiles.length} changed files.`,
    sessionId: input.session ?? null,
    changedFiles: report.changedFiles,
    verification: report.verification,
    reportPaths: jobReportPaths(report)
  });
}
