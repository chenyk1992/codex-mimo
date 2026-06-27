import path from "node:path";
import fs from "node:fs";
import { buildMimoRunArgs } from "../mimo/run-json.js";
import { captureGitDiff, type GitDiffSnapshot, captureGitStatus, type GitStatusSnapshot } from "../git/diff.js";
import { extractSessionIdFromEvents, parseMimoJsonLines } from "./events.js";
import { writeComposeReport, type ComposeReport } from "./report.js";
import { runMimoCliStreaming } from "./streaming-runner.js";
import { normalizeVerificationCommands, runVerificationCommands, type VerificationResult } from "./verify.js";
import { buildComposePrompt, getComposeWorkflow, type ComposeWorkflowName } from "./workflow.js";
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

import type { TerminationReason } from "./streaming-runner.js";

export interface ComposeRunInput {
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
  dryRun?: boolean;
  reportDir?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface ComposeProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  terminationReason?: TerminationReason;
}

interface ComposeRunnerDeps {
  runMimo?: (cwd: string, args: string[], options?: { timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }) => Promise<ComposeProcessResult>;
  captureDiff?: (cwd: string, base?: string) => Promise<GitDiffSnapshot>;
  captureStatus?: (cwd: string) => Promise<GitStatusSnapshot>;
  runVerification?: (cwd: string, commands: string[]) => Promise<VerificationResult[]>;
  writeReport?: (report: ComposeReport) => void;
  createHookCallbackController?: typeof createHookCallbackController;
  now?: () => Date;
}

export async function runComposeWorkflow(
  input: ComposeRunInput,
  deps: ComposeRunnerDeps = {}
): Promise<ComposeReport> {
  const timeoutMs = input.timeoutMs ?? 1_800_000;
  const workflow = getComposeWorkflow(input.workflow);
  validateComposeInput(input, workflow.requiresTask, workflow.requiresFile);

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
  const createdAt = now().toISOString();
  const id = `${createdAt.replace(/[:.]/g, "-")}-compose-${workflow.name}`;
  const reportDir = input.reportDir ?? path.join(input.cwd, ".codex-mimo", "reports");
  const eventsDir = path.join(input.cwd, ".codex-mimo", "events");
  const diffsDir = path.join(input.cwd, ".codex-mimo", "diffs");
  const writeReport = deps.writeReport ?? writeComposeReport;
  const captureStatus = deps.captureStatus ?? captureGitStatus;

  let gitStatusBefore: GitStatusSnapshot | undefined;
  try {
    gitStatusBefore = await captureStatus(input.cwd);
  } catch {
    // Git status capture is best-effort
  }

  if (input.dryRun) {
    const report = buildComposeReportFromRun({
      id,
      createdAt,
      input,
      mimoArgs,
      requestedSkills: workflow.skillChain,
      eventsStdout: "",
      diff: { changedFiles: [], diffStat: "", diff: "" },
      verification: [],
      reportDir,
      eventsDir,
      diffsDir,
      status: "needs_review",
      gitStatusBefore
    });
    writeReport(report);
    return report;
  }

  const runMimo = deps.runMimo ?? defaultRunMimo;
  const captureDiff = deps.captureDiff ?? captureGitDiff;
  const runVerification = deps.runVerification ?? runVerificationCommands;

  let mimoResult: ComposeProcessResult;
  let callback: MimoHookCallbackSummary | null = null;
  let callbackTimedOut = false;
  let hook: HookCallbackController | null = null;
  try {
    hook = await createComposeHook(input.cwd, `compose-${workflow.name}`, deps);
    try {
      mimoResult = await runMimo(input.cwd, mimoArgs, { timeoutMs, signal: input.signal, env: hook.env });
      callback = await hook.waitForCallback();
      callbackTimedOut = callback === null;
    } finally {
      await hook.close();
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const report = buildComposeReportFromRun({
      id,
      createdAt,
      input,
      mimoArgs,
      requestedSkills: workflow.skillChain,
      eventsStdout: "",
      diff: { changedFiles: [], diffStat: "", diff: "" },
      verification: [],
      reportDir,
      eventsDir,
      diffsDir,
      status: "failed",
      gitStatusBefore,
      callback,
      callbackTimedOut,
      error: `MiMoCode execution failed: ${errorMessage}`
    });
    writeReport(report);
    return report;
  }
  const callbackError = callbackFailureMessage(callback, callbackTimedOut);

  let diff: GitDiffSnapshot;
  try {
    diff = await captureDiff(input.cwd, input.since ?? "HEAD");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    diff = { changedFiles: [], diffStat: "", diff: "" };
    const report = buildComposeReportFromRun({
      id,
      createdAt,
      input,
      mimoArgs,
      requestedSkills: workflow.skillChain,
      eventsStdout: mimoResult.stdout,
      diff,
      verification: [],
      reportDir,
      eventsDir,
      diffsDir,
      status: "failed",
      gitStatusBefore,
      callback,
      callbackTimedOut,
      error: callbackError ?? `Git diff capture failed: ${errorMessage}`
    });
    writeReport(report);
    return report;
  }

  let gitStatusAfter: GitStatusSnapshot | undefined;
  try {
    gitStatusAfter = await captureStatus(input.cwd);
  } catch {
    // Git status capture is best-effort
  }

  const readOnlyViolationFiles = detectReadOnlyViolationFiles(
    workflow.writesAllowed,
    diff.changedFiles,
    gitStatusBefore,
    gitStatusAfter
  );
  if (readOnlyViolationFiles.length > 0) {
    const violationDiff = buildReadOnlyReportDiff(diff, readOnlyViolationFiles);
    const report = buildComposeReportFromRun({
      id,
      createdAt,
      input,
      mimoArgs,
      requestedSkills: workflow.skillChain,
      eventsStdout: mimoResult.stdout,
      diff: violationDiff,
      verification: [],
      reportDir,
      eventsDir,
      diffsDir,
      status: "failed",
      gitStatusBefore,
      gitStatusAfter,
      callback,
      callbackTimedOut,
      error: callbackError ?? `Read-only workflow ${workflow.name} modified files: ${readOnlyViolationFiles.join(", ")}`
    });
    writeReport(report);
    return report;
  }

  let reportDiff = workflow.writesAllowed ? diff : buildReadOnlyReportDiff(diff, readOnlyViolationFiles);
  if (workflow.writesAllowed && gitStatusBefore && gitStatusAfter) {
    const statusNewFiles = detectNewFilesFromStatus(gitStatusBefore, gitStatusAfter);
    if (statusNewFiles.length > 0) {
      const merged = [...new Set([...reportDiff.changedFiles, ...statusNewFiles])];
      reportDiff = { ...reportDiff, changedFiles: merged };
    }
  }
  const verificationCommands = normalizeVerificationCommands(input.verification, workflow.defaultVerification, input.cwd);
  let verification: VerificationResult[] = [];
  try {
    verification = await runVerification(input.cwd, verificationCommands);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const report = buildComposeReportFromRun({
      id,
      createdAt,
      input,
      mimoArgs,
      requestedSkills: workflow.skillChain,
      eventsStdout: mimoResult.stdout,
      diff: reportDiff,
      verification: [],
      reportDir,
      eventsDir,
      diffsDir,
      status: "failed",
      gitStatusBefore,
      gitStatusAfter,
      callback,
      callbackTimedOut,
      error: callbackError ?? `Verification execution failed: ${errorMessage}`
    });
    writeReport(report);
    return report;
  }

  const semanticFailure = detectSemanticFailure(mimoResult.stdout);
  if (semanticFailure) {
    const report = buildComposeReportFromRun({
      id,
      createdAt,
      input,
      mimoArgs,
      requestedSkills: workflow.skillChain,
      eventsStdout: mimoResult.stdout,
      diff: reportDiff,
      verification,
      reportDir,
      eventsDir,
      diffsDir,
      status: "failed",
      gitStatusBefore,
      gitStatusAfter,
      callback,
      callbackTimedOut,
      error: callbackError ?? semanticFailure
    });
    writeReport(report);
    return report;
  }

  const status = determineStatus(mimoResult.exitCode, reportDiff.changedFiles, verification, callback, callbackTimedOut);
  const report = buildComposeReportFromRun({
    id,
    createdAt,
    input,
    mimoArgs,
    requestedSkills: workflow.skillChain,
    eventsStdout: mimoResult.stdout,
    diff: reportDiff,
    verification,
    reportDir,
    eventsDir,
    diffsDir,
    status,
    terminationReason: mimoResult.terminationReason,
    gitStatusBefore,
    gitStatusAfter,
    callback,
    callbackTimedOut,
    error: status === "timeout" ? timeoutError(mimoResult.terminationReason) : callbackError
  });

  writeReport(report);
  return report;
}

async function defaultRunMimo(
  cwd: string,
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}
): Promise<ComposeProcessResult> {
  return runMimoCliStreaming(cwd, args, { timeoutMs: options.timeoutMs, signal: options.signal, env: options.env });
}

async function createComposeHook(
  cwd: string,
  kind: string,
  deps: ComposeRunnerDeps
): Promise<HookCallbackController> {
  const createHook = deps.createHookCallbackController ?? createHookCallbackController;
  return createHook({ cwd, kind });
}

function validateComposeInput(input: ComposeRunInput, requiresTask: boolean, requiresFile: boolean): void {
  if (requiresTask && !input.task?.trim()) {
    throw new Error(`Workflow ${input.workflow} requires a task.`);
  }
  if (requiresFile && !input.file?.trim()) {
    throw new Error(`Workflow ${input.workflow} requires --file.`);
  }
}

function determineStatus(
  mimoExitCode: number,
  changedFiles: string[],
  verification: VerificationResult[],
  callback?: MimoHookCallbackSummary | null,
  callbackTimedOut = false
): "passed" | "failed" | "needs_review" | "timeout" {
  if (mimoExitCode === 124) return "timeout";
  if (callbackTimedOut || callback?.outcome === "error" || callback?.outcome === "cancelled") return "failed";
  if (mimoExitCode !== 0) return "failed";
  if (verification.some((result) => !result.passed)) return "failed";
  if (verification.length === 0 && changedFiles.length > 0) return "needs_review";
  return "passed";
}

function callbackFailureMessage(callback: MimoHookCallbackSummary | null, callbackTimedOut: boolean): string | undefined {
  if (callbackTimedOut) return "MiMoCode exited before codex-mimo received session.post.";
  if (callback?.outcome === "error" || callback?.outcome === "cancelled") {
    return callback.error ?? `MiMoCode completion callback reported ${callback.outcome}.`;
  }
  return undefined;
}

export function timeoutError(reason?: TerminationReason): string {
  if (reason === "host_abort") return "MiMoCode was interrupted by the host tool call before completion.";
  if (reason === "user_cancelled") return "MiMoCode was cancelled by the user.";
  return "MiMoCode exceeded the configured process timeout.";
}



export function buildComposeReportFromRun(input: {
  id: string;
  createdAt: string;
  input: ComposeRunInput;
  mimoArgs: string[];
  requestedSkills: string[];
  eventsStdout: string;
  diff: GitDiffSnapshot;
  verification: VerificationResult[];
  reportDir: string;
  eventsDir: string;
  diffsDir: string;
  status: "passed" | "failed" | "needs_review" | "timeout";
  terminationReason?: TerminationReason;
  callback?: MimoHookCallbackSummary | null;
  callbackTimedOut?: boolean;
  gitStatusBefore?: GitStatusSnapshot;
  gitStatusAfter?: GitStatusSnapshot;
  error?: string;
}): ComposeReport {
  const events = parseMimoJsonLines(input.eventsStdout);
  const sessionId = input.callback?.sessionId ?? extractSessionIdFromEvents(events);
  const diffPath = input.diff.diff ? path.join(input.diffsDir, `${input.id}.diff`) : undefined;

  if (diffPath && input.diff.diff) {
    fs.mkdirSync(input.diffsDir, { recursive: true });
    fs.writeFileSync(diffPath, input.diff.diff, "utf-8");
  }

  return {
    id: input.id,
    createdAt: input.createdAt,
    workflow: input.input.workflow,
    cwd: input.input.cwd,
    task: input.input.task ?? `Run ${input.input.workflow} workflow.`,
    mimoArgs: input.mimoArgs,
    requestedSkills: input.requestedSkills,
    status: input.status,
    events,
    changedFiles: input.diff.changedFiles,
    diffStat: input.diff.diffStat,
    diffPath,
    terminationReason: input.terminationReason,
    sessionId,
    callback: input.callback,
    callbackTimedOut: input.callbackTimedOut,
    gitStatusBefore: input.gitStatusBefore,
    gitStatusAfter: input.gitStatusAfter,
    verification: input.verification,
    reviewText: extractReviewText(events),
    planText: extractPlanText(events),
    error: input.error,
    reportPaths: {
      json: path.join(input.reportDir, `${input.id}.json`),
      markdown: path.join(input.reportDir, `${input.id}.md`),
      eventsJsonl: path.join(input.eventsDir, `${input.id}.jsonl`)
    }
  };
}

function extractReviewText(events: ReturnType<typeof parseMimoJsonLines>): string | undefined {
  const messages = events
    .filter((event) => event.type === "message" && event.text)
    .map((event) => event.text)
    .filter(Boolean);
  return messages.length > 0 ? messages.join("\n\n") : undefined;
}

function extractPlanText(events: ReturnType<typeof parseMimoJsonLines>): string | undefined {
  const planMessages = events
    .filter((event) => event.type === "message" && event.text)
    .map((event) => event.text!)
    .filter(isStructuredPlanText);
  return planMessages.length > 0 ? planMessages.join("\n\n") : undefined;
}

function isStructuredPlanText(text: string): boolean {
  const hasStructure =
    /^##\s+task\b/m.test(text) ||
    /^###\s+task\b/m.test(text) ||
    /^##\s+step\b/m.test(text) ||
    /^###\s+step\b/m.test(text) ||
    /^##\s+phase\b/m.test(text) ||
    /^-\s+\[[ x]\]/m.test(text) ||
    /^\d+\.\s+/m.test(text);
  if (!hasStructure) return false;
  const chatterPatterns = [
    /i'm using the compose:/i,
    /i'll use the compose:/i,
    /using the .* skill/i,
    /skill to create/i,
    /skill to generate/i,
  ];
  return !chatterPatterns.some((p) => p.test(text));
}
