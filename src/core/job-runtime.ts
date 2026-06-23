import { normalizeMimoEvent } from "../compose/events.js";
import { appendJobEventLine, appendJobLogLine } from "./job-log.js";
import { inferPhaseFromEvent, summarizeEventForLog } from "./job-phase.js";
import { readJob, updateJob } from "./job-store.js";
import type { JobRecord, JobReportPaths, JobVerification } from "./jobs.js";

export function startRuntimeJob(cwd: string, jobId: string, patch: { pid?: number | null } = {}): JobRecord {
  return updateJob(cwd, jobId, {
    status: "running",
    phase: "starting",
    startedAt: new Date().toISOString(),
    pid: patch.pid ?? null,
    summary: "Starting MiMoCode job."
  });
}

export function appendRuntimeEvent(cwd: string, jobId: string, line: string): JobRecord {
  const job = mustReadJob(cwd, jobId);
  appendJobEventLine(job.eventsFile, line);

  let raw: unknown = line;
  try {
    raw = JSON.parse(line);
  } catch {
    raw = { type: "raw", text: line };
  }

  const event = normalizeMimoEvent(raw);
  const phase = inferPhaseFromEvent(event);
  const summary = summarizeEventForLog(event);
  if (summary) appendJobLogLine(job.logFile, summary);

  return updateJob(cwd, jobId, {
    ...(phase ? { phase } : {}),
    ...(summary ? { summary } : {})
  });
}

export function completeRuntimeJob(
  cwd: string,
  jobId: string,
  result: {
    summary: string;
    sessionId?: string | null;
    changedFiles: string[];
    verification: JobVerification[];
    reportPaths?: JobReportPaths;
  }
): JobRecord {
  const job = mustReadJob(cwd, jobId);
  appendJobLogLine(job.logFile, result.summary);
  return updateJob(cwd, jobId, {
    status: "completed",
    phase: "done",
    pid: null,
    completedAt: new Date().toISOString(),
    summary: result.summary,
    sessionId: result.sessionId ?? job.sessionId ?? null,
    changedFiles: result.changedFiles,
    verification: result.verification,
    reportPaths: result.reportPaths
  });
}

export function failRuntimeJob(
  cwd: string,
  jobId: string,
  failure: {
    errorCode: string;
    error: string;
    reportPaths?: JobReportPaths;
  }
): JobRecord {
  const job = mustReadJob(cwd, jobId);
  appendJobLogLine(job.logFile, failure.error);
  return updateJob(cwd, jobId, {
    status: "failed",
    phase: "failed",
    pid: null,
    completedAt: new Date().toISOString(),
    errorCode: failure.errorCode,
    error: failure.error,
    reportPaths: failure.reportPaths ?? job.reportPaths
  });
}

function mustReadJob(cwd: string, jobId: string): JobRecord {
  const job = readJob(cwd, jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  return job;
}
