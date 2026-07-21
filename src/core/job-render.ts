import type {
  JobNotificationStatus,
  JobRecord,
  JobResult,
  JobStatusResult,
  JobVerification
} from "./jobs.js";
import { publicProgressSummary } from "./public-summary.js";

function elapsedMs(job: JobRecord, nowMs = Date.now()): number | null {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, nowMs - start);
}

function idleMsFor(job: JobRecord, nowMs: number): number | null {
  if (job.status !== "running" || !job.lastEventAt) return null;
  const last = Date.parse(job.lastEventAt);
  if (!Number.isFinite(last)) return null;
  return Math.max(0, nowMs - last);
}

export interface RenderJobStatusOptions {
  nowMs?: number;
  progress?: string[];
  notification?: JobNotificationStatus;
  processAlive?: boolean | "unknown";
}

export function renderJobStatus(
  job: JobRecord,
  options: RenderJobStatusOptions = {}
): JobStatusResult {
  const nowMs = options.nowMs ?? Date.now();
  const hasPid = typeof job.pid === "number" && job.pid > 0;
  const processAlive = options.processAlive !== undefined
    ? options.processAlive
    : (job.status === "running" && hasPid ? ("unknown" as const) : undefined);
  return {
    jobId: job.id,
    kind: job.kind,
    parentJobId: job.parentJobId ?? null,
    status: job.status,
    ...(job.phase ? { phase: job.phase } : {}),
    elapsedMs: elapsedMs(job, nowMs),
    sessionId: job.sessionId ?? null,
    summary: publicProgressSummary({
      type: "job",
      status: job.status,
      phase: job.phase,
      ...(job.errorCode !== undefined ? { errorCode: job.errorCode } : {})
    }),
    changedFiles: [...job.changedFiles],
    ...(job.cancellationRequestedAt ? { cancellationRequested: true as const } : {}),
    ...(job.executionCallback ? { executionCallback: publicExecutionCallback(job) } : {}),
    progress: (options.progress ?? []).map(() => publicProgressSummary({
      type: "job",
      status: job.status,
      phase: job.phase,
      ...(job.errorCode !== undefined ? { errorCode: job.errorCode } : {})
    })),
    ...(options.notification ? { notification: publicNotification(options.notification) } : {}),
    lastEventAt: job.lastEventAt ?? null,
    idleMs: idleMsFor(job, nowMs),
    lastTool: job.lastTool ?? null,
    ...(processAlive !== undefined ? { processAlive } : {}),
    idleTimeoutMs: job.idleTimeoutMs ?? null,
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
    summary: publicProgressSummary({
      type: "job",
      status: job.status,
      phase: job.phase,
      ...(job.errorCode !== undefined ? { errorCode: job.errorCode } : {})
    }),
    sessionId: job.sessionId ?? null,
    changedFiles: [...job.changedFiles],
    verification: job.verification.map(compactVerification),
    ...(job.executionCallback ? { executionCallback: publicExecutionCallback(job) } : {}),
    ...(job.error
      ? {
          error: publicProgressSummary({
            type: "job",
            status: job.status,
            ...(job.errorCode !== undefined ? { errorCode: job.errorCode } : {})
          })
        }
      : {}),
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    ...(job.reportPaths ? { reportPaths: { ...job.reportPaths } } : {}),
    ...(notification ? { notification: publicNotification(notification) } : {}),
    actions: {
      status: "mimo_status",
      events: "mimo_events",
      ...(partial ? { resume: "mimo_resume" as const } : {})
    }
  };
}

function publicExecutionCallback(job: JobRecord): NonNullable<JobRecord["executionCallback"]> {
  const callback = job.executionCallback!;
  return {
    invocationId: callback.invocationId,
    outcome: callback.outcome,
    ...(callback.sessionId !== undefined ? { sessionId: callback.sessionId } : {}),
    ...(callback.receivedAt !== undefined ? { receivedAt: callback.receivedAt } : {}),
    ...(callback.error !== undefined
      ? { error: publicProgressSummary({ type: "callback", outcome: callback.outcome }) }
      : {})
  };
}

function publicNotification(notification: JobNotificationStatus): JobNotificationStatus {
  return {
    targetType: notification.targetType,
    status: notification.status,
    attempts: notification.attempts,
    ...(notification.lastError !== undefined
      ? { lastError: publicProgressSummary({ type: "notification" }) }
      : {})
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
