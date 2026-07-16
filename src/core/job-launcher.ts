import { createJobStore, type CreateJobInput } from "./job-store.js";
import { spawnJobWorker } from "./job-process.js";
import { transitionJob } from "./job-transition.js";
import type { JobKind, JobReceipt, JobRecord } from "./jobs.js";
import { resolveNotificationTarget } from "../notify/target.js";
import type { NotificationInput, NotificationTarget } from "../notify/types.js";

export interface LaunchJobInput {
  kind: JobKind;
  cwd: string;
  task: string;
  request: unknown;
  parentJobId?: string;
  notify?: NotificationInput;
}

export interface LaunchJobDependencies {
  env?: NodeJS.ProcessEnv;
  resolveTarget?: (
    input: NotificationInput | undefined,
    env: NodeJS.ProcessEnv
  ) => NotificationTarget | undefined;
  createJob?: (cwd: string, input: CreateJobInput) => JobRecord;
  spawnJobWorker?: typeof spawnJobWorker;
  transitionJob?: typeof transitionJob;
}

export async function launchJob(
  input: LaunchJobInput,
  dependencies: LaunchJobDependencies = {}
): Promise<JobReceipt> {
  assertImplementWriteAuthorization(input);
  const target = (dependencies.resolveTarget ?? resolveNotificationTarget)(
    input.notify,
    dependencies.env ?? process.env
  );
  const createJob = dependencies.createJob ?? ((cwd, createInput) =>
    createJobStore(cwd).create(createInput));
  const job = createJob(input.cwd, {
    kind: input.kind,
    task: input.task,
    request: input.request,
    parentJobId: input.parentJobId,
    notificationTarget: target
  });

  try {
    const pid = (dependencies.spawnJobWorker ?? spawnJobWorker)(input.cwd, job.id);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error("Job worker spawn did not return a process ID.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await (dependencies.transitionJob ?? transitionJob)(input.cwd, job.id, {
      status: "failed",
      summary: `Job worker failed to start: ${message}`,
      error: message,
      errorCode: "worker_spawn_failed"
    });
    throw error;
  }

  return toJobReceipt(job);
}

export function toJobReceipt(job: JobRecord): JobReceipt {
  return {
    jobId: job.id,
    kind: job.kind,
    status: "queued",
    actions: {
      status: "mimo_status",
      events: "mimo_events",
      result: "mimo_result",
      cancel: "mimo_cancel"
    }
  };
}

function assertImplementWriteAuthorization(input: LaunchJobInput): void {
  if (input.kind !== "implement") return;
  const request = input.request;
  if (typeof request !== "object" || request === null ||
      !("allowWrite" in request) || request.allowWrite !== true) {
    throw new Error("mimo_implement requires allowWrite=true.");
  }
}
