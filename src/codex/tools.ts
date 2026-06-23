import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";
import {
  ComposeInput,
  FixCiInput,
  HealthcheckInput,
  ImplementInput,
  PlanInput,
  ReviewInput,
  ResumeInput
} from "./tool-schemas.js";
import { implementPrompt, planPrompt, reviewPrompt } from "../core/prompt.js";
import { runAndCapture } from "../mimo/mimo-runner.js";
import { runComposeWorkflow } from "../compose/runner.js";
import { compactComposeReportForCodex } from "./compact.js";
import type { CompactComposeReport } from "./compact.js";
import { createJobStore, updateJob } from "../core/job-store.js";
import { spawnJobWorker } from "../core/job-process.js";
import { renderJobLaunch } from "../core/job-render.js";

export async function mimoHealthcheck(input: unknown) {
  const parsed = HealthcheckInput.parse(input);
  const cwd = parsed.cwd ?? process.cwd();
  try {
    const result = await execa("mimo", ["--version"], { cwd });
    return {
      ok: true,
      version: result.stdout.trim(),
      cwd
    };
  } catch {
    return { ok: false, error: "mimo not found or not working", cwd };
  }
}

export async function mimoPlan(input: unknown) {
  const parsed = PlanInput.parse(input);
  const result = await runAndCapture({
    cwd: parsed.cwd,
    agent: parsed.agent,
    model: parsed.model,
    message: planPrompt(parsed.task)
  });
  return {
    summary: result.summary,
    sessionId: result.sessionId,
    changedFiles: result.changedFiles,
    verification: result.commands
  };
}

export async function mimoImplement(input: unknown) {
  const parsed = ImplementInput.parse(input);
  if (!parsed.allowWrite) {
    throw new Error("mimo_implement requires allowWrite=true.");
  }
  const before = await captureWorktreeFiles(parsed.cwd);
  const result = await runAndCapture({
    cwd: parsed.cwd,
    agent: "build",
    message: implementPrompt(parsed.task)
  });
  const after = await captureWorktreeFiles(parsed.cwd);
  return {
    summary: result.summary,
    sessionId: result.sessionId,
    changedFiles: mergeChangedFiles(result.changedFiles, diffAddedFiles(before, after)),
    commands: result.commands,
    risks: result.errors
  };
}

export async function mimoReview(input: unknown) {
  const parsed = ReviewInput.parse(input);
  const diffResult = await execa("git", ["diff", parsed.base], { cwd: parsed.cwd, reject: false });
  if (diffResult.exitCode !== 0) {
    throw new Error(`Git diff capture failed: ${diffResult.stderr || `exit ${diffResult.exitCode}`}`);
  }

  const diffSummary = diffResult.stdout || "No changes found.";
  let files: string[] | undefined;
  let prompt = reviewPrompt(diffSummary);
  if (diffResult.stdout) {
    const diffFile = writeReviewDiffInput(parsed.cwd, parsed.base, diffResult.stdout);
    files = [diffFile];
    prompt = reviewPrompt(`The current diff is attached as @${diffFile}. Review that attached diff.`);
  }

  const result = await runAndCapture({
    cwd: parsed.cwd,
    agent: "plan",
    message: prompt,
    files
  });

  if (result.exitCode !== 0 || result.errors.length > 0) {
    throw new Error(`MiMoCode review failed: ${result.errors.join("\n") || `exit ${result.exitCode}`}`);
  }

  if (result.summary === "Completed." && result.raw.length === 0) {
    throw new Error("MiMoCode review produced no review output.");
  }
  
  // Return findings based on review content
  const findings = result.summary && result.summary !== "Completed."
    ? [{ severity: "info", title: "Review Summary", body: result.summary }]
    : [];

  return {
    summary: result.summary,
    sessionId: result.sessionId,
    findings
  };
}

function writeReviewDiffInput(cwd: string, base: string, diff: string): string {
  const dir = path.join(cwd, ".codex-mimo", "review-inputs");
  fs.mkdirSync(dir, { recursive: true });
  const safeBase = base.replace(/[^a-zA-Z0-9_.-]/g, "_") || "HEAD";
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeBase}.diff`);
  fs.writeFileSync(file, diff, "utf-8");
  return file;
}

export async function mimoFixCi(input: unknown) {
  const parsed = FixCiInput.parse(input);
  const before = await captureWorktreeFiles(parsed.cwd);
  const result = await runAndCapture({
    cwd: parsed.cwd,
    agent: "build",
    message: implementPrompt(parsed.task ?? "Fix the CI failures shown in the attached log."),
    files: [parsed.file]
  });
  const after = await captureWorktreeFiles(parsed.cwd);
  return {
    summary: result.summary,
    sessionId: result.sessionId,
    changedFiles: mergeChangedFiles(result.changedFiles, diffAddedFiles(before, after)),
    commands: result.commands,
    risks: result.errors
  };
}

export async function mimoResume(input: unknown) {
  const parsed = ResumeInput.parse(input);
  const before = await captureWorktreeFiles(parsed.cwd);
  const result = await runAndCapture({
    cwd: parsed.cwd,
    agent: "build",
    message: parsed.task,
    session: parsed.session
  });
  const after = await captureWorktreeFiles(parsed.cwd);
  return {
    summary: result.summary,
    sessionId: result.sessionId,
    changedFiles: mergeChangedFiles(result.changedFiles, diffAddedFiles(before, after)),
    commands: result.commands,
    risks: result.errors
  };
}

export async function mimoCompose(
  input: unknown,
  deps: { spawnJobWorker?: typeof spawnJobWorker } = {}
): Promise<CompactComposeReport | ReturnType<typeof renderJobLaunch>> {
  const parsed = ComposeInput.parse(input);
  if (parsed.background) {
    const store = createJobStore(parsed.cwd);
    const job = store.create({
      kind: "compose",
      workflow: parsed.workflow,
      task: parsed.task ?? `Run ${parsed.workflow} workflow.`,
      request: parsed
    });
    const pid = (deps.spawnJobWorker ?? spawnJobWorker)(parsed.cwd, "compose", job.id);
    const queued = updateJob(parsed.cwd, job.id, { pid });
    return renderJobLaunch(queued);
  }

  const report = await runComposeWorkflow(parsed);
  return compactComposeReportForCodex(report);
}

async function captureWorktreeFiles(cwd: string): Promise<Set<string>> {
  try {
    const result = await execa("git", ["status", "--short", "--untracked-files=all"], {
      cwd,
      reject: false
    });
    return new Set(
      (result.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

function diffAddedFiles(before: Set<string>, after: Set<string>): string[] {
  return [...after].filter((file) => !before.has(file));
}

function mergeChangedFiles(primary: string[], fallback: string[]): string[] {
  return [...new Set([...primary, ...fallback])];
}
