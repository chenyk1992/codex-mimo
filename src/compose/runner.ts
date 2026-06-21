import path from "node:path";
import { execa } from "execa";
import { buildMimoRunArgs } from "../mimo/run-json.js";
import { captureGitDiff, type GitDiffSnapshot } from "../git/diff.js";
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
    files: input.file ? [input.file] : []
  });

  const now = deps.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const id = `${createdAt.replace(/[:.]/g, "-")}-compose-${workflow.name}`;
  const reportDir = input.reportDir ?? path.join(input.cwd, ".codex-mimo", "reports");
  const eventsDir = path.join(input.cwd, ".codex-mimo", "events");

  if (input.dryRun) {
    return buildReport({
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
      status: "needs_review"
    });
  }

  const runMimo = deps.runMimo ?? defaultRunMimo;
  const captureDiff = deps.captureDiff ?? captureGitDiff;
  const runVerification = deps.runVerification ?? runVerificationCommands;
  const writeReport = deps.writeReport ?? writeComposeReport;

  const mimo = await runMimo(input.cwd, mimoArgs);
  const diff = await captureDiff(input.cwd, input.since ?? "HEAD");
  const verificationCommands = normalizeVerificationCommands(input.verification, workflow.defaultVerification);
  const verification = await runVerification(input.cwd, verificationCommands);

  const status = determineStatus(mimo.exitCode, diff.changedFiles, verification);
  const report = buildReport({
    id,
    createdAt,
    input,
    mimoArgs,
    requestedSkills: workflow.skillChain,
    eventsStdout: mimo.stdout,
    diff,
    verification,
    reportDir,
    eventsDir,
    status
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
  status: "passed" | "failed" | "needs_review";
}): ComposeReport {
  const events = parseMimoJsonLines(input.eventsStdout);
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
    verification: input.verification,
    reviewText: extractReviewText(events),
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
