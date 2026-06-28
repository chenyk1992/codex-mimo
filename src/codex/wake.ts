import type { JobSignalKind, JobSignalLevel } from "../core/job-signals.js";
import { isActiveJobStatus, type JobRecord } from "../core/jobs.js";

const DEFAULT_WAKE_TIMEOUT_MS = 1_800_000;

export const CODEX_WAKE_ATTENTION_KINDS: JobSignalKind[] = [
  "needs_input",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "timeout"
];

export interface BuildCodexWakeHintOptions {
  sinceCursor?: number;
  minLevel?: JobSignalLevel;
  timeoutMs?: number;
}

export interface CodexWakeHint {
  kind: "codex_heartbeat";
  jobId: string;
  status: JobRecord["status"];
  phase: JobRecord["phase"];
  attentionKinds: JobSignalKind[];
  watch?: {
    tool: "mimo_wait";
    arguments: {
      cwd: string;
      jobId: string;
      sinceCursor: number;
      minLevel: JobSignalLevel;
      timeoutMs: number;
    };
  };
  heartbeat?: {
    tool: "automation_update";
    arguments: {
      mode: "create";
      kind: "heartbeat";
      destination: "thread";
      name: string;
      prompt: string;
      rrule: string;
      status: "ACTIVE";
    };
  };
  result?: {
    tool: "mimo_result";
    arguments: {
      cwd: string;
      jobId: string;
    };
  };
  prompt: string;
}

export function buildCodexWakeHint(job: JobRecord, options: BuildCodexWakeHintOptions = {}): CodexWakeHint {
  const sinceCursor = options.sinceCursor ?? 0;
  const minLevel = options.minLevel ?? "info";
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;
  const argumentsJson = JSON.stringify({
    cwd: job.cwd,
    jobId: job.id,
    sinceCursor,
    minLevel,
    timeoutMs
  });
  const attentionKinds = CODEX_WAKE_ATTENTION_KINDS;
  const base = {
    kind: "codex_heartbeat" as const,
    jobId: job.id,
    status: job.status,
    phase: job.phase,
    attentionKinds
  };

  if (!isActiveJobStatus(job.status)) {
    const resultArguments = {
      cwd: job.cwd,
      jobId: job.id
    };
    const prompt = [
      `MiMoCode job ${job.id} is already ${job.status}.`,
      `Call mimo_result with ${JSON.stringify(resultArguments)}.`,
      "Summarize the result for the user; no follow-up automation is needed."
    ].join(" ");

    return {
      ...base,
      result: {
        tool: "mimo_result",
        arguments: resultArguments
      },
      prompt
    };
  }

  const prompt = [
    `Monitor MiMoCode job ${job.id}.`,
    `Call mimo_wait with ${argumentsJson}.`,
    `If a signal kind is one of ${attentionKinds.join(", ")}, call mimo_result for job ${job.id} and summarize the result for the user.`,
    "If mimo_wait times out without signals, send a short status update and create another heartbeat if the job is still active."
  ].join(" ");

  return {
    ...base,
    watch: {
      tool: "mimo_wait",
      arguments: {
        cwd: job.cwd,
        jobId: job.id,
        sinceCursor,
        minLevel,
        timeoutMs
      }
    },
    heartbeat: {
      tool: "automation_update",
      arguments: {
        mode: "create",
        kind: "heartbeat",
        destination: "thread",
        name: `MiMoCode job ${job.id}`,
        prompt,
        rrule: "FREQ=MINUTELY;COUNT=1",
        status: "ACTIVE"
      }
    },
    prompt
  };
}
