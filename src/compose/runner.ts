import path from "node:path";
import fs from "node:fs";
import { buildMimoRunArgs } from "../mimo/run-json.js";
import { captureGitDiff, type GitDiffSnapshot } from "../git/diff.js";
import { captureGitStatus, type GitStatusSnapshot } from "../git/status.js";
import { extractSessionIdFromEvents, parseMimoJsonLines } from "./events.js";
import { writeComposeReport, type ComposeReport } from "./report.js";
import { runMimoCliStreaming } from "./streaming-runner.js";
import { normalizeVerificationCommands, runVerificationCommands, type VerificationResult } from "./verify.js";
import { buildComposePrompt, getComposeWorkflow, type ComposeWorkflowName } from "./workflow.js";
import { preparePromptTransport } from "../mimo/prompt-transport.js";

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

interface MimoRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  terminationReason?: "process_timeout" | "host_abort" | "user_cancelled";
}

interface ComposeRunnerDeps {
  runMimo?: (cwd: string, args: string[], options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<MimoRunResult>;
  captureDiff?: (cwd: string, base?: string) => Promise<GitDiffSnapshot>;
  captureStatus?: (cwd: string) => Promise<GitStatusSnapshot>;
  runVerification?: (cwd: string, commands: string[]) => Promise<VerificationResult[]>;
  writeReport?: (report: ComposeReport) => void;
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

  let mimoResult: MimoRunResult;
  try {
    mimoResult = await runMimo(input.cwd, mimoArgs, { timeoutMs, signal: input.signal });
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
      error: `MiMoCode execution failed: ${errorMessage}`
    });
    writeReport(report);
    return report;
  }

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
      error: `Git diff capture failed: ${errorMessage}`
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
      error: `Read-only workflow ${workflow.name} modified files: ${readOnlyViolationFiles.join(", ")}`
    });
    writeReport(report);
    return report;
  }

  const reportDiff = workflow.writesAllowed ? diff : buildReadOnlyReportDiff(diff, readOnlyViolationFiles);
  const verificationCommands = normalizeVerificationCommands(input.verification, workflow.defaultVerification);
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
      error: `Verification execution failed: ${errorMessage}`
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
      error: semanticFailure
    });
    writeReport(report);
    return report;
  }

  const status = determineStatus(mimoResult.exitCode, reportDiff.changedFiles, verification);
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
    error: status === "timeout" ? timeoutError(mimoResult.terminationReason) : undefined
  });

  writeReport(report);
  return report;
}

async function defaultRunMimo(
  cwd: string,
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<MimoRunResult> {
  return runMimoCliStreaming(cwd, args, { timeoutMs: options.timeoutMs, signal: options.signal });
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
  verification: VerificationResult[]
): "passed" | "failed" | "needs_review" | "timeout" {
  if (mimoExitCode === 124) return "timeout";
  if (mimoExitCode !== 0) return "failed";
  if (verification.some((result) => !result.passed)) return "failed";
  if (verification.length === 0 && changedFiles.length > 0) return "needs_review";
  return "passed";
}

export function timeoutError(reason?: "process_timeout" | "host_abort" | "user_cancelled"): string {
  if (reason === "host_abort") return "MiMoCode was interrupted by the host tool call before completion.";
  if (reason === "user_cancelled") return "MiMoCode was cancelled by the user.";
  return "MiMoCode exceeded the configured process timeout.";
}

function detectSemanticFailure(eventsStdout: string): string | undefined {
  const events = parseMimoJsonLines(eventsStdout);
  const messages = events.filter((event) => event.type === "message" && event.text);

  // Only check first 3 messages - real failures appear early
  const earlyMessages = messages.slice(0, 3);

  for (const event of earlyMessages) {
    const text = (event.text ?? "").toLowerCase().trim();

    // Skip long messages (likely code analysis, not actual failure)
    if (text.length > 500) continue;

    // Skip messages containing code blocks (source code references)
    if (text.includes("```")) continue;

    // Skip messages that look like they're explaining code (contain function signatures)
    if (/\bfunction\s+\w+\s*\(/.test(text) || /\bconst\s+\w+\s*=/.test(text)) continue;

    // Match patterns - allow at start of sentence or after common delimiters
    const failurePatterns = [
      /what would you like me to help/i,
      /what would you like to work on/i,
      /what would you like to accomplish/i,
      /what task or problem/i,
      /what do you need/i,
      /how can i help/i,
      /what are you trying to accomplish/i,
      /please share your task/i,
      /objective is empty/i,
      /task is empty/i,
      /no objective provided/i,
      /no task provided/i,
      /haven't provided a task/i,
      /haven't provided an actual task/i,
      /message got cut off/i,
      /what's the objective/i,
      /what is the objective/i,
    ];

    const matchesFailure = failurePatterns.some((pattern) => pattern.test(text));

    // Also check for standalone questions (short message ending with ?)
    const isStandaloneQuestion = text.length < 150 && text.endsWith("?") &&
      /^(what|how|please)\s/i.test(text);

    if (matchesFailure || isStandaloneQuestion) {
      return "MiMoCode did not receive or accept the task objective.";
    }
  }

  return undefined;
}

function detectReadOnlyViolationFiles(
  writesAllowed: boolean,
  changedFiles: string[],
  gitStatusBefore?: GitStatusSnapshot,
  gitStatusAfter?: GitStatusSnapshot
): string[] {
  if (writesAllowed) return [];
  if (!gitStatusBefore || !gitStatusAfter) return changedFiles;

  const beforeFiles = parseGitStatusFiles(gitStatusBefore.short);
  const afterFiles = parseGitStatusFiles(gitStatusAfter.short);
  return [...afterFiles].filter((file) => !beforeFiles.has(file));
}

function buildReadOnlyReportDiff(diff: GitDiffSnapshot, readOnlyViolationFiles: string[]): GitDiffSnapshot {
  if (readOnlyViolationFiles.length === 0) {
    return { changedFiles: [], diffStat: "", diff: "" };
  }

  return {
    ...diff,
    changedFiles: readOnlyViolationFiles
  };
}

function parseGitStatusFiles(status: string): Set<string> {
  return new Set(
    status
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => (line.length > 3 ? line.slice(3).trim() : line.trim()))
      .filter(Boolean)
  );
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
  terminationReason?: "process_timeout" | "host_abort" | "user_cancelled";
  gitStatusBefore?: GitStatusSnapshot;
  gitStatusAfter?: GitStatusSnapshot;
  error?: string;
}): ComposeReport {
  const events = parseMimoJsonLines(input.eventsStdout);
  const sessionId = extractSessionIdFromEvents(events);
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
    .filter((text) => {
      const lower = text.toLowerCase();
      return (
        lower.includes("implementation plan") ||
        lower.includes("# plan") ||
        lower.includes("## task") ||
        (lower.includes("### task") && lower.includes("step")) ||
        (lower.includes("- [ ]") && lower.length > 200)
      );
    });
  return planMessages.length > 0 ? planMessages.join("\n\n") : undefined;
}
