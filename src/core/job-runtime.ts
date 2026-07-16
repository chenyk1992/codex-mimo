import { normalizeMimoEvent } from "../compose/events.js";
import { appendJobEventLine, appendJobLogLine } from "./job-log.js";
import { inferPhaseFromEvent, summarizeEventForLog } from "./job-phase.js";
import { appendJobSignal } from "./job-signals.js";
import { readJob, updateJob } from "./job-store.js";
import { isActiveJobStatus } from "./jobs.js";
import type { JobCallbackSummary, JobRecord, JobReportPaths, JobVerification } from "./jobs.js";

export function startRuntimeJob(
  cwd: string,
  jobId: string,
  patch: { pid?: number | null; processIdentity?: string | null } = {}
): JobRecord {
  const job = updateJob(cwd, jobId, {
    status: "running",
    phase: "starting",
    startedAt: new Date().toISOString(),
    pid: patch.pid ?? null,
    processIdentity: patch.processIdentity ?? null,
    summary: "Starting MiMoCode job.",
    completedAt: undefined,
    errorCode: undefined,
    error: undefined,
    callback: undefined,
    reportPaths: undefined
  });
  appendJobSignal(job.signalsFile, {
    jobId,
    kind: "phase_changed",
    level: "info",
    status: job.status,
    phase: job.phase,
    summary: job.summary ?? "Starting MiMoCode job."
  });
  return job;
}

export function appendRuntimeEvent(cwd: string, jobId: string, line: string): JobRecord {
  const job = mustReadJob(cwd, jobId);
  if (!isActiveJobStatus(job.status)) return job;
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

  const updated = updateJob(cwd, jobId, {
    ...(phase ? { phase } : {}),
    ...(summary ? { summary } : {})
  });
  if (phase && phase !== job.phase) {
    appendJobSignal(job.signalsFile, {
      jobId,
      kind: "phase_changed",
      level: "info",
      status: updated.status,
      phase,
      summary: summary ?? `${job.kind} job entered ${phase}.`
    });
  }
  if (summary) {
    appendJobSignal(job.signalsFile, {
      jobId,
      kind: "milestone",
      level: event.type === "error" ? "error" : "info",
      status: updated.status,
      phase: updated.phase,
      summary
    });
  }
  return updated;
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
    callback?: JobCallbackSummary;
  }
): JobRecord {
  const job = mustReadJob(cwd, jobId);
  if (!isActiveJobStatus(job.status)) return job;
  appendJobLogLine(job.logFile, result.summary);
  const updated = updateJob(cwd, jobId, {
    status: "completed",
    phase: "done",
    pid: null,
    processIdentity: null,
    completedAt: new Date().toISOString(),
    summary: result.summary,
    sessionId: result.sessionId ?? job.sessionId ?? null,
    changedFiles: result.changedFiles,
    verification: result.verification,
    callback: result.callback,
    reportPaths: result.reportPaths,
    errorCode: undefined,
    error: undefined
  });
  appendJobSignal(updated.signalsFile, {
    jobId,
    kind: "completed",
    level: "info",
    status: updated.status,
    phase: updated.phase,
    summary: result.summary,
    reportPaths: result.reportPaths
  });
  return updated;
}

export function failRuntimeJob(
  cwd: string,
  jobId: string,
  failure: {
    errorCode: string;
    error: string;
    sessionId?: string | null;
    changedFiles?: string[];
    reportPaths?: JobReportPaths;
    callback?: JobCallbackSummary;
  }
): JobRecord {
  const job = mustReadJob(cwd, jobId);
  if (!isActiveJobStatus(job.status)) return job;
  appendJobLogLine(job.logFile, failure.error);
  const updated = updateJob(cwd, jobId, {
    status: "failed",
    phase: "failed",
    pid: null,
    processIdentity: null,
    completedAt: new Date().toISOString(),
    errorCode: failure.errorCode,
    error: failure.error,
    sessionId: failure.sessionId ?? job.sessionId ?? null,
    ...(failure.changedFiles ? { changedFiles: failure.changedFiles } : {}),
    callback: failure.callback,
    reportPaths: failure.reportPaths ?? job.reportPaths
  });
  appendJobSignal(updated.signalsFile, {
    jobId,
    kind: failure.errorCode === "timeout" ? "timeout" : "failed",
    level: "error",
    status: updated.status,
    phase: updated.phase,
    summary: failure.error,
    reportPaths: updated.reportPaths
  });
  return updated;
}

export function cancelRuntimeJob(cwd: string, jobId: string, summary = `Cancelled ${jobId}.`): JobRecord {
  const job = mustReadJob(cwd, jobId);
  appendJobLogLine(job.logFile, summary);
  const updated = updateJob(cwd, jobId, {
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    processIdentity: null,
    completedAt: new Date().toISOString(),
    summary,
    errorCode: "cancelled",
    error: "Cancelled by user."
  });
  appendJobSignal(updated.signalsFile, {
    jobId,
    kind: "cancelled",
    level: "warn",
    status: updated.status,
    phase: updated.phase,
    summary
  });
  return updated;
}

function mustReadJob(cwd: string, jobId: string): JobRecord {
  const job = readJob(cwd, jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  return job;
}
