import {
  isActiveJobStatus,
  type JobLaunchResult,
  type JobRecord,
  type JobResult,
  type JobStatusResult
} from "./jobs.js";

function elapsedMs(job: JobRecord, nowMs = Date.now()): number | null {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, nowMs - start);
}

export function renderJobLaunch(job: JobRecord): JobLaunchResult {
  return {
    jobId: job.id,
    status: job.status,
    phase: job.phase,
    summary: `Started ${job.kind} job ${job.id}.`,
    actions: {
      status: "mimo_status",
      result: "mimo_result",
      cancel: "mimo_cancel"
    }
  };
}

export function renderJobStatus(
  job: JobRecord,
  options: { nowMs?: number; progress?: string[] } = {}
): JobStatusResult {
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    phase: job.phase,
    elapsedMs: elapsedMs(job, options.nowMs),
    sessionId: job.sessionId ?? null,
    summary: job.summary ?? `${job.kind} job ${job.status}.`,
    changedFiles: job.changedFiles,
    callback: job.callback,
    progress: options.progress ?? [],
    actions: {
      ...(isActiveJobStatus(job.status) ? { cancel: "mimo_cancel" as const } : { result: "mimo_result" as const })
    }
  };
}

export function renderJobResult(job: JobRecord): JobResult {
  return {
    jobId: job.id,
    status: job.status,
    summary: job.summary ?? `${job.kind} job ${job.status}.`,
    sessionId: job.sessionId ?? null,
    changedFiles: job.changedFiles,
    verification: job.verification,
    callback: job.callback,
    error: job.error,
    errorCode: job.errorCode,
    reportPaths: job.reportPaths,
    ...(job.sessionId ? { resumeHint: { tool: "mimo_resume_job" as const, jobId: job.id } } : {}),
    ...(job.sessionId ? { directResumeHint: { tool: "mimo_resume" as const, session: job.sessionId } } : {})
  };
}
