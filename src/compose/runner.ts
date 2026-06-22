import path from "node:path";
import fs from "node:fs";
import { execa } from "execa";
import { buildMimoRunArgs } from "../mimo/run-json.js";
import { captureGitDiff, type GitDiffSnapshot } from "../git/diff.js";
import { captureGitStatus, type GitStatusSnapshot } from "../git/status.js";
import { parseMimoJsonLines } from "./events.js";
import { writeComposeReport, type ComposeReport } from "./report.js";
import { normalizeVerificationCommands, runVerificationCommands, type VerificationResult } from "./verify.js";
import { buildComposePrompt, getComposeWorkflow, type ComposeWorkflowName } from "./workflow.js";

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
}

export interface MimoRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ComposeRunnerDeps {
  runMimo?: (cwd: string, args: string[]) => Promise<MimoRunResult>;
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
  const workflow = getComposeWorkflow(input.workflow);
  validateComposeInput(input, workflow.requiresTask, workflow.requiresFile);

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
    const report = buildReport({
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
    mimoResult = await runMimo(input.cwd, mimoArgs);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const report = buildReport({
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
      error: `MiMoCode startup failed: ${errorMessage}`
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
    const report = buildReport({
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
    const report = buildReport({
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
      gitStatusAfter,
      error: `Read-only workflow ${workflow.name} modified files: ${readOnlyViolationFiles.join(", ")}`
    });
    writeReport(report);
    return report;
  }

  const verificationCommands = normalizeVerificationCommands(input.verification, workflow.defaultVerification);
  let verification: VerificationResult[] = [];
  try {
    verification = await runVerification(input.cwd, verificationCommands);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const report = buildReport({
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
      gitStatusAfter,
      error: `Verification execution failed: ${errorMessage}`
    });
    writeReport(report);
    return report;
  }

  const semanticFailure = detectSemanticFailure(mimoResult.stdout);
  if (semanticFailure) {
    const report = buildReport({
      id,
      createdAt,
      input,
      mimoArgs,
      requestedSkills: workflow.skillChain,
      eventsStdout: mimoResult.stdout,
      diff,
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

  const status = determineStatus(mimoResult.exitCode, diff.changedFiles, verification);
  const report = buildReport({
    id,
    createdAt,
    input,
    mimoArgs,
    requestedSkills: workflow.skillChain,
    eventsStdout: mimoResult.stdout,
    diff,
    verification,
    reportDir,
    eventsDir,
    diffsDir,
    status,
    gitStatusBefore,
    gitStatusAfter
  });

  writeReport(report);
  return report;
}

async function defaultRunMimo(cwd: string, args: string[]): Promise<MimoRunResult> {
  const result = await execa("mimo", args, {
    cwd,
    reject: false,
    stdin: "ignore"
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1
  };
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
): "passed" | "failed" | "needs_review" {
  if (mimoExitCode !== 0) return "failed";
  if (verification.some((result) => !result.passed)) return "failed";
  if (verification.length === 0 && changedFiles.length > 0) return "needs_review";
  return "passed";
}

function detectSemanticFailure(eventsStdout: string): string | undefined {
  const events = parseMimoJsonLines(eventsStdout);
  const text = events
    .filter((event) => event.type === "message" && event.text)
    .map((event) => event.text)
    .join("\n")
    .toLowerCase();

  const emptyObjectivePatterns = [
    "objective is empty",
    "what would you like me to help with",
    "task is empty",
    "no objective provided",
    "no task provided",
    "message got cut off",
    "what's the objective",
    "what is the objective",
    "haven't provided a task",
    "haven't provided an actual task or objective",
    "please share your task",
    "what would you like to work on",
    "what would you like to accomplish"
  ];

  if (emptyObjectivePatterns.some((pattern) => text.includes(pattern))) {
    return "MiMoCode did not receive or accept the task objective.";
  }

  return undefined;
}

function detectReadOnlyViolationFiles(
  writesAllowed: boolean,
  changedFiles: string[],
  gitStatusBefore?: GitStatusSnapshot,
  gitStatusAfter?: GitStatusSnapshot
): string[] {
  if (writesAllowed || changedFiles.length === 0) return [];
  if (!gitStatusBefore || !gitStatusAfter) return changedFiles;
  if (!gitStatusBefore.dirty && gitStatusAfter.dirty) return changedFiles;

  const beforeFiles = parseGitStatusFiles(gitStatusBefore.short);
  const afterFiles = parseGitStatusFiles(gitStatusAfter.short);
  return [...afterFiles].filter((file) => !beforeFiles.has(file));
}

function parseGitStatusFiles(status: string): Set<string> {
  return new Set(
    status
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
  );
}

function buildReport(input: {
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
  status: "passed" | "failed" | "needs_review";
  gitStatusBefore?: GitStatusSnapshot;
  gitStatusAfter?: GitStatusSnapshot;
  error?: string;
}): ComposeReport {
  const events = parseMimoJsonLines(input.eventsStdout);
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
    gitStatusBefore: input.gitStatusBefore,
    gitStatusAfter: input.gitStatusAfter,
    verification: input.verification,
    reviewText: extractReviewText(events),
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
