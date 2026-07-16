import type {
  JobNotificationStatus,
  JobRecord,
  JobResult,
  JobStatusResult,
  JobVerification
} from "./jobs.js";

function elapsedMs(job: JobRecord, nowMs = Date.now()): number | null {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, nowMs - start);
}

export function renderJobStatus(
  job: JobRecord,
  options: {
    nowMs?: number;
    progress?: string[];
    notification?: JobNotificationStatus;
  } = {}
): JobStatusResult {
  return {
    jobId: job.id,
    kind: job.kind,
    parentJobId: job.parentJobId ?? null,
    status: job.status,
    ...(job.phase ? { phase: job.phase } : {}),
    elapsedMs: elapsedMs(job, options.nowMs),
    sessionId: job.sessionId ?? null,
    summary: job.summary ?? `${job.kind} job ${job.status}.`,
    changedFiles: [...job.changedFiles],
    ...(job.executionCallback ? { executionCallback: { ...job.executionCallback } } : {}),
    progress: options.progress ?? [],
    ...(options.notification ? { notification: options.notification } : {}),
    actions: statusActions(job.status)
  };
}

export function renderJobResult(
  job: JobRecord,
  notification?: JobNotificationStatus
): JobResult {
  const partial = job.status === "needs_input" || job.status === "blocked";
  return {
    jobId: job.id,
    kind: job.kind,
    parentJobId: job.parentJobId ?? null,
    status: job.status,
    resultType: partial ? "partial" : "final",
    summary: job.summary ?? `${job.kind} job ${job.status}.`,
    sessionId: job.sessionId ?? null,
    changedFiles: [...job.changedFiles],
    verification: job.verification.map(compactVerification),
    ...(job.executionCallback ? { executionCallback: { ...job.executionCallback } } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    ...(job.reportPaths ? { reportPaths: { ...job.reportPaths } } : {}),
    ...(notification ? { notification } : {}),
    actions: {
      status: "mimo_status",
      events: "mimo_events",
      ...(partial ? { resume: "mimo_resume" as const } : {})
    }
  };
}

function statusActions(status: JobRecord["status"]): JobStatusResult["actions"] {
  if (status === "queued" || status === "running") {
    return {
      events: "mimo_events",
      wait: "mimo_wait",
      cancel: "mimo_cancel"
    };
  }
  if (status === "needs_input" || status === "blocked") {
    return {
      result: "mimo_result",
      events: "mimo_events",
      resume: "mimo_resume"
    };
  }
  return { result: "mimo_result", events: "mimo_events" };
}

function compactVerification(result: JobVerification): JobVerification {
  return {
    command: result.command,
    exitCode: result.exitCode,
    passed: result.passed,
    ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs })
  };
}
