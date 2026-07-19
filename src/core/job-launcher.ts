import { createJobStore, type CreateJobInput } from "./job-store.js";
import {
  spawnJobSupervisor,
  spawnNotificationWorker
} from "./job-process.js";
import { transitionJob } from "./job-transition.js";
import type { JobKind, JobReceipt, JobRecord } from "./jobs.js";
import { resolveNotificationTarget } from "../notify/target.js";
import { startNotificationDispatch } from "../notify/dispatch-process.js";
import type { NotificationInput, NotificationTarget } from "../notify/types.js";

export interface LaunchJobInput {
  kind: JobKind;
  cwd: string;
  task: string;
  request: unknown;
  parentJobId?: string;
  notify?: NotificationInput;
  notificationTarget?: NotificationTarget | null;
}

export interface LaunchJobDependencies {
  env?: NodeJS.ProcessEnv;
  resolveTarget?: (
    input: NotificationInput | undefined,
    env: NodeJS.ProcessEnv
  ) => NotificationTarget | undefined;
  createJob?: (cwd: string, input: CreateJobInput) => JobRecord;
  spawnJobSupervisor?: typeof spawnJobSupervisor;
  spawnNotificationWorker?: typeof spawnNotificationWorker;
  transitionJob?: typeof transitionJob;
}

export async function launchJob(
  input: LaunchJobInput,
  dependencies: LaunchJobDependencies = {}
): Promise<JobReceipt> {
  assertImplementWriteAuthorization(input);
  if (input.notify !== undefined && input.notificationTarget !== undefined) {
    throw new Error("A job launch cannot both resolve and reuse a notification target.");
  }
  const target = input.notificationTarget === undefined
    ? (dependencies.resolveTarget ?? resolveNotificationTarget)(
        input.notify,
        dependencies.env ?? process.env
      )
    : cloneTarget(input.notificationTarget);
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
    const pid = (dependencies.spawnJobSupervisor ?? spawnJobSupervisor)(input.cwd);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error("Job supervisor spawn did not return a process ID.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await (dependencies.transitionJob ?? transitionJob)(input.cwd, job.id, {
      status: "failed",
      summary: `Job supervisor failed to start: ${message}`,
      error: message,
      errorCode: "worker_spawn_failed"
    });
    if (failed.deliveryCreated) {
      startNotificationDispatch(input.cwd, {
        spawnNotificationWorker: dependencies.spawnNotificationWorker
      });
    }
    throw error;
  }

  return toJobReceipt(job);
}

function cloneTarget(target: NotificationTarget | null): NotificationTarget | undefined {
  if (target === null) return undefined;
  return target.type === "codex"
    ? { type: "codex", threadId: target.threadId }
    : { type: "webhook", url: target.url, secretEnv: target.secretEnv };
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
