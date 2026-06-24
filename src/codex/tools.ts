import { execa } from "execa";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ComposeInput,
  FixCiInput,
  HealthcheckInput,
  ImplementInput,
  JobCancelInput,
  JobListInput,
  JobResultInput,
  JobStatusInput,
  PlanInput,
  ResumeInput,
  ResumeJobInput,
  ReviewInput
} from "./tool-schemas.js";
import { implementPrompt, planPrompt, reviewPrompt } from "../core/prompt.js";
import { runAndCapture } from "../mimo/mimo-runner.js";
import { runComposeWorkflow } from "../compose/runner.js";
import { compactComposeReportForCodex } from "./compact.js";
import type { CompactComposeReport } from "./compact.js";
import { createJobStore, listJobs, readJob, updateJob } from "../core/job-store.js";
import { spawnJobWorker, terminateJobProcess } from "../core/job-process.js";
import { isActiveJobStatus } from "../core/jobs.js";
import { renderJobLaunch, renderJobResult, renderJobStatus } from "../core/job-render.js";
import { readRecentJobLogLines } from "../core/job-log.js";
import { SessionStore } from "../core/sessions.js";

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
    message: planPrompt(parsed.task),
    timeoutMs: parsed.timeoutMs
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
    message: implementPrompt(parsed.task),
    timeoutMs: parsed.timeoutMs
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
  const dir = path.join(os.tmpdir(), "codex-mimo-review-inputs");
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
    files: [parsed.file],
    timeoutMs: parsed.timeoutMs
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
    session: parsed.session,
    timeoutMs: parsed.timeoutMs
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
  deps: { spawnJobWorker?: typeof spawnJobWorker } = {},
  options: { signal?: AbortSignal } = {}
): Promise<CompactComposeReport | ReturnType<typeof renderJobLaunch> | ReturnType<typeof renderJobStatus>> {
  const parsed = ComposeInput.parse(input);
  if (parsed.background) {
    const store = createJobStore(parsed.cwd);
    const job = store.create({
      kind: "compose",
      workflow: parsed.workflow,
      task: parsed.task ?? `Run ${parsed.workflow} workflow.`,
      request: parsed
    });
    const spawnFn = deps.spawnJobWorker ?? spawnJobWorker;
    const pid = spawnFn(parsed.cwd, "compose", job.id, {
      onExit: (code, signal) => {
        const current = readJob(parsed.cwd, job.id);
        if (current && isActiveJobStatus(current.status)) {
          updateJob(parsed.cwd, job.id, {
            status: "failed",
            phase: "failed",
            pid: null,
            completedAt: new Date().toISOString(),
            errorCode: "worker_exit",
            error: `Worker process exited unexpectedly (code=${code}, signal=${signal}).`
          });
        }
      }
    });
    const queued = updateJob(parsed.cwd, job.id, { pid });
    if (parsed.wait) {
      const settled = await waitForJobToSettle(parsed.cwd, job.id);
      return renderJobStatus(settled ?? queued, {
        progress: readRecentJobLogLines((settled ?? queued).logFile, 5)
      });
    }
    return renderJobLaunch(queued);
  }

  const report = await runComposeWorkflow({ ...parsed, signal: options.signal });
  return compactComposeReportForCodex(report);
}

export async function mimoStatus(input: unknown) {
  const parsed = JobStatusInput.parse(input);
  const jobs = listJobs(parsed.cwd);
  const job = parsed.jobId ? readJob(parsed.cwd, parsed.jobId) : jobs[0];
  if (!job) throw new Error("No jobs recorded for this workspace.");
  return renderJobStatus(job, {
    progress: readRecentJobLogLines(job.logFile, 5)
  });
}

export async function mimoResult(input: unknown) {
  const parsed = JobResultInput.parse(input);
  const jobs = listJobs(parsed.cwd).filter((job) => job.status !== "queued" && job.status !== "running");
  const job = parsed.jobId ? readJob(parsed.cwd, parsed.jobId) : jobs[0];
  if (!job) throw new Error("No finished jobs recorded for this workspace.");
  if (job.sessionId) {
    new SessionStore(job.cwd).save({
      sessionId: job.sessionId,
      workflow: job.workflow ?? job.kind,
      task: job.task,
      cwd: job.cwd,
      jobId: job.id,
      parentJobId: job.parentJobId ?? null,
      status: job.status,
      reportPaths: job.reportPaths,
      summary: job.summary
    });
  }
  return renderJobResult(job);
}

export async function mimoJobs(input: unknown) {
  const parsed = JobListInput.parse(input);
  const jobs = listJobs(parsed.cwd);
  return (parsed.all ? jobs : jobs.slice(0, 8)).map((job) => renderJobStatus(job, {
    progress: readRecentJobLogLines(job.logFile, 3)
  }));
}

export async function mimoCancel(
  input: unknown,
  deps: { killProcess?: (pid: number) => void } = {}
) {
  const parsed = JobCancelInput.parse(input);
  const job = readJob(parsed.cwd, parsed.jobId);
  if (!job) throw new Error(`No job found for ${parsed.jobId}.`);
  terminateJobProcess(job.pid, { killProcess: deps.killProcess });
  const cancelled = updateJob(parsed.cwd, job.id, {
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt: new Date().toISOString(),
    summary: `Cancelled ${job.id}.`,
    errorCode: "cancelled",
    error: "Cancelled by user."
  });
  return renderJobResult(cancelled);
}

export async function mimoResumeJob(
  input: unknown,
  deps: { spawnJobWorker?: typeof spawnJobWorker } = {}
) {
  const parsed = ResumeJobInput.parse(input);
  const parent = readJob(parsed.cwd, parsed.jobId);
  if (!parent) throw new Error(`No job found for ${parsed.jobId}.`);
  if (!parent.sessionId) {
    throw new Error(`Job ${parent.id} does not have a sessionId and cannot be resumed.`);
  }
  const store = createJobStore(parsed.cwd);
  const child = store.create({
    kind: "resume",
    workflow: parent.workflow,
    task: parsed.task,
    request: {
      cwd: parsed.cwd,
      workflow: parent.workflow ?? "dev",
      task: parsed.task,
      session: parent.sessionId,
      continue: true,
      background: parsed.background
    },
    parentJobId: parent.id
  });
  if (parsed.background) {
    const spawnFn = deps.spawnJobWorker ?? spawnJobWorker;
    const pid = spawnFn(parsed.cwd, "compose", child.id, {
      onExit: (code, signal) => {
        const current = readJob(parsed.cwd, child.id);
        if (current && isActiveJobStatus(current.status)) {
          updateJob(parsed.cwd, child.id, {
            status: "failed",
            phase: "failed",
            pid: null,
            completedAt: new Date().toISOString(),
            errorCode: "worker_exit",
            error: `Worker process exited unexpectedly (code=${code}, signal=${signal}).`
          });
        }
      }
    });
    return renderJobLaunch(updateJob(parsed.cwd, child.id, { pid }));
  }
  return {
    jobId: child.id,
    parentJobId: parent.id,
    sessionId: parent.sessionId,
    status: child.status,
    summary: "Resume job created. Run it in background with background=true."
  };
}

async function captureWorktreeFiles(cwd: string): Promise<Set<string> | undefined> {
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
    return undefined;
  }
}

function diffAddedFiles(before: Set<string> | undefined, after: Set<string> | undefined): string[] {
  if (!before || !after) return [];
  return [...after].filter((file) => !before.has(file));
}

function mergeChangedFiles(primary: string[], fallback: string[]): string[] {
  return [...new Set([...primary, ...fallback])];
}

const DEFAULT_BACKGROUND_WAIT_MS = 5_000;
const BACKGROUND_WAIT_POLL_MS = 250;

async function waitForJobToSettle(cwd: string, jobId: string, waitMs = DEFAULT_BACKGROUND_WAIT_MS) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const job = readJob(cwd, jobId);
    if (!job || !isActiveJobStatus(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, BACKGROUND_WAIT_POLL_MS));
  }
  return readJob(cwd, jobId);
}
