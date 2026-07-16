import { execa } from "execa";
import {
  ComposeInput,
  FixCiInput,
  HealthcheckInput,
  ImplementInput,
  JobCancelInput,
  JobEventsInput,
  JobWakeInput,
  JobWaitInput,
  JobListInput,
  JobResultInput,
  JobStatusInput,
  PlanInput,
  ResumeInput,
  ResumeJobInput,
  ReviewInput
} from "./tool-schemas.js";
import { launchJob, type LaunchJobDependencies } from "../core/job-launcher.js";
import { implementPrompt } from "../core/prompt.js";
import { runAndCapture, type MimoRunResult } from "../mimo/mimo-runner.js";
import { createJobStore, listJobs, readJob } from "../core/job-store.js";
import { spawnJobWorker, terminateJobProcess } from "../core/job-process.js";
import { isActiveJobStatus, type JobRecord } from "../core/jobs.js";
import { renderJobLaunch, renderJobResult, renderJobStatus } from "../core/job-render.js";
import { readRecentJobLogLines } from "../core/job-log.js";
import { readJobSignals } from "../core/job-signals.js";
import { cancelRuntimeJob } from "../core/job-runtime.js";
import { SessionStore } from "../core/sessions.js";
import { resolveMimoCommand } from "../mimo/run-json.js";
import { detectDirectSemanticFailure } from "../compose/post-checks.js";
import { buildCodexWakeHint } from "./wake.js";

export async function mimoHealthcheck(input: unknown) {
  const parsed = HealthcheckInput.parse(input);
  const cwd = parsed.cwd ?? process.cwd();
  try {
    const result = await execa(resolveMimoCommand(), ["--version"], { cwd });
    return {
      ok: true,
      version: result.stdout.trim(),
      cwd
    };
  } catch {
    return { ok: false, error: "mimo not found or not working", cwd };
  }
}

export async function mimoPlan(input: unknown, deps: LaunchJobDependencies = {}) {
  const parsed = PlanInput.parse(input);
  const { notify, ...request } = parsed;
  return launchJob({
    kind: "plan",
    cwd: parsed.cwd,
    task: parsed.task,
    request,
    notify
  }, deps);
}

export async function mimoImplement(input: unknown, deps: LaunchJobDependencies = {}) {
  const parsed = ImplementInput.parse(input);
  const { notify, ...request } = parsed;
  return launchJob({
    kind: "implement",
    cwd: parsed.cwd,
    task: parsed.task,
    request,
    notify
  }, deps);
}

export async function mimoReview(input: unknown, deps: LaunchJobDependencies = {}) {
  const parsed = ReviewInput.parse(input);
  const { notify, ...request } = parsed;
  return launchJob({
    kind: "review",
    cwd: parsed.cwd,
    task: `Review changes since ${parsed.base}.`,
    request,
    notify
  }, deps);
}

export async function mimoFixCi(input: unknown, deps: LaunchJobDependencies = {}) {
  const parsed = FixCiInput.parse(input);
  const { notify, ...request } = parsed;
  return launchJob({
    kind: "fix-ci",
    cwd: parsed.cwd,
    task: parsed.task ?? "Fix the CI failures shown in the attached log.",
    request,
    notify
  }, deps);
}

export async function mimoCompose(input: unknown, deps: LaunchJobDependencies = {}) {
  const parsed = ComposeInput.parse(input);
  const { notify, ...request } = parsed;
  return launchJob({
    kind: "compose",
    cwd: parsed.cwd,
    task: parsed.task ?? `Run ${parsed.workflow} workflow.`,
    request,
    notify
  }, deps);
}

/* Task 10 migrates resume to the parent-job contract. */
export async function mimoResume(input: unknown) {
  const parsed = ResumeInput.parse(input);
  const { result, changedFiles } = await runWritableMimo({
    cwd: parsed.cwd,
    label: "resume",
    message: implementPrompt(parsed.task),
    session: parsed.session,
    timeoutMs: parsed.timeoutMs
  });
  return renderWritableMimoResult(result, changedFiles);
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

export async function mimoEvents(input: unknown) {
  const parsed = JobEventsInput.parse(input);
  const job = resolveJobForSignals(parsed.cwd, parsed.jobId);
  return renderJobSignals(job, readJobSignals(job.signalsFile, {
    sinceCursor: parsed.sinceCursor,
    limit: parsed.limit,
    minLevel: parsed.minLevel
  }));
}

export async function mimoWait(input: unknown) {
  const parsed = JobWaitInput.parse(input);
  const selected = resolveJobForSignals(parsed.cwd, parsed.jobId);
  const startedAt = Date.now();
  const deadline = startedAt + parsed.timeoutMs;
  let job = selected;
  let result = readJobSignals(job.signalsFile, {
    sinceCursor: parsed.sinceCursor,
    limit: parsed.limit,
    minLevel: parsed.minLevel
  });

  while (result.signals.length === 0 && isActiveJobStatus(job.status) && Date.now() < deadline) {
    await sleep(Math.min(parsed.pollMs, Math.max(1, deadline - Date.now())));
    job = readJob(parsed.cwd, selected.id) ?? job;
    result = readJobSignals(job.signalsFile, {
      sinceCursor: parsed.sinceCursor,
      limit: parsed.limit,
      minLevel: parsed.minLevel
    });
  }

  return {
    ...renderJobSignals(job, result),
    timedOut: result.signals.length === 0 && isActiveJobStatus(job.status),
    waitedMs: Date.now() - startedAt
  };
}

export async function mimoWake(input: unknown) {
  const parsed = JobWakeInput.parse(input);
  const job = resolveJobForSignals(parsed.cwd, parsed.jobId);
  return buildCodexWakeHint(job, {
    sinceCursor: parsed.sinceCursor,
    minLevel: parsed.minLevel,
    timeoutMs: parsed.timeoutMs
  });
}

function resolveJobForSignals(cwd: string, jobId?: string): JobRecord {
  const jobs = listJobs(cwd);
  const job = jobId ? readJob(cwd, jobId) : jobs[0];
  if (!job) {
    throw new Error(jobId ? `No job found for ${jobId}.` : "No jobs recorded for this workspace.");
  }
  return job;
}

function renderJobSignals(job: JobRecord, result: ReturnType<typeof readJobSignals>) {
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    phase: job.phase,
    nextCursor: result.nextCursor,
    signals: result.signals,
    actions: {
      status: "mimo_status" as const,
      result: "mimo_result" as const,
      ...(isActiveJobStatus(job.status) ? { cancel: "mimo_cancel" as const } : {})
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function mimoResult(input: unknown) {
  const parsed = JobResultInput.parse(input);
  const jobs = listJobs(parsed.cwd).filter((job) => job.status !== "queued" && job.status !== "running");
  const job = parsed.jobId ? readJob(parsed.cwd, parsed.jobId) : jobs[0];
  if (!job) throw new Error("No finished jobs recorded for this workspace.");
  if (job.sessionId) {
    new SessionStore(job.cwd).save({
      sessionId: job.sessionId,
      workflow: job.kind,
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
  const cancelled = cancelRuntimeJob(parsed.cwd, job.id);
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
    task: parsed.task,
    request: {
      cwd: parsed.cwd,
      task: parsed.task,
      session: parent.sessionId,
      continue: true,
      background: parsed.background
    },
    parentJobId: parent.id
  });
  if (parsed.background) {
    const spawnFn = deps.spawnJobWorker ?? spawnJobWorker;
    spawnFn(parsed.cwd, child.id);
    return renderJobLaunch(readJob(parsed.cwd, child.id) ?? child);
  }
  return {
    jobId: child.id,
    parentJobId: parent.id,
    sessionId: parent.sessionId,
    status: child.status,
    summary: "Resume job created. Run it in background with background=true."
  };
}

interface WritableMimoRunInput {
  cwd: string;
  label: string;
  message: string;
  files?: string[];
  session?: string;
  timeoutMs?: number;
}

async function runWritableMimo({ label, ...options }: WritableMimoRunInput): Promise<{
  result: MimoRunResult;
  changedFiles: string[];
}> {
  const before = await captureWorktreeFiles(options.cwd);
  const result = await runAndCapture({ ...options, agent: "build" });
  assertMimoRunSucceeded(result, label);
  const after = await captureWorktreeFiles(options.cwd);
  return {
    result,
    changedFiles: mergeChangedFiles(result.changedFiles, diffAddedFiles(before, after))
  };
}

function renderWritableMimoResult(
  { summary, sessionId, commands, errors }: MimoRunResult,
  changedFiles: string[]
) {
  return {
    summary,
    sessionId,
    changedFiles,
    commands,
    risks: errors
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

function assertMimoRunSucceeded(result: MimoRunResult, label: string): void {
  const failure = mimoRunFailureMessage(result, label);
  if (failure) throw new Error(failure);
}

function mimoRunFailureMessage(result: MimoRunResult, label: string): string | null {
  const semanticFailure = detectDirectSemanticFailure(result.summary);
  if (semanticFailure) return `MiMoCode ${label} failed: ${semanticFailure}`;
  if (result.exitCode === 0) return null;
  return `MiMoCode ${label} failed: ${result.errors.join("\n") || `exit ${result.exitCode}`}`;
}
