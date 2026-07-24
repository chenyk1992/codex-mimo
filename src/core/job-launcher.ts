import { createJobStore, type CreateJobInput } from "./job-store.js";
import { InputValidationError } from "./input-validation.js";
import {
  spawnJobSupervisor,
  spawnNotificationWorker
} from "./job-process.js";
import { transitionJob } from "./job-transition.js";
import type { JobKind, JobReceipt, JobRecord } from "./jobs.js";
import {
  prepareCodexConnection,
  type PreparedCodexConnection
} from "../notify/codex-connection.js";
import { resolveNotificationTarget } from "../notify/target.js";
import { startNotificationDispatch } from "../notify/dispatch-process.js";
import type {
  NotificationErrorCode,
  NotificationInput,
  NotificationTarget
} from "../notify/types.js";

const PREFLIGHT_ERROR_CODES = new Set<NotificationErrorCode>([
  "codex_cli_not_found",
  "codex_cli_not_executable",
  "codex_app_server_unavailable",
  "codex_app_server_incompatible",
  "codex_thread_missing",
  "codex_thread_forbidden"
]);

function preflightRecovery(errorCode: NotificationErrorCode): string {
  switch (errorCode) {
    case "codex_cli_not_found":
      return "Set CODEX_MIMO_CODEX_BIN to a runnable standalone Codex CLI, restart Codex Desktop, then run mimo_healthcheck.";
    case "codex_cli_not_executable":
      return "Set CODEX_MIMO_CODEX_BIN to a standalone Codex CLI outside protected WindowsApps packages, restart Codex Desktop, then run mimo_healthcheck.";
    case "codex_app_server_unavailable":
      return "The selected Codex CLI did not pass its launchability check. Run mimo_healthcheck and verify CODEX_MIMO_CODEX_BIN before retrying.";
    case "codex_app_server_incompatible":
      return "The selected Codex CLI is incompatible with the required App Server protocol. Update Codex Desktop or set CODEX_MIMO_CODEX_BIN to a compatible standalone Codex CLI, restart Codex Desktop, then run mimo_healthcheck.";
    case "codex_thread_missing":
      return "The selected Codex task is unavailable. Open the target task in Codex Desktop and retry with its current threadId.";
    case "codex_thread_forbidden":
      return "The selected Codex task is not accessible from this Codex session. Open the target task in Codex Desktop and retry with a task you can access.";
    case "codex_thread_busy":
      return "The selected Codex task is currently busy. Wait for its current turn to finish, then retry.";
    case "codex_turn_interrupted":
    case "codex_turn_failed":
    case "codex_turn_timeout":
      return "Codex callback delivery failed. Allow durable retry.";
  }
}

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
  prepareCodex?: typeof prepareCodexConnection;
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
  const env = dependencies.env ?? process.env;
  const target = input.notificationTarget === undefined
    ? (dependencies.resolveTarget ?? resolveNotificationTarget)(
        input.notify,
        env
      )
    : cloneTarget(input.notificationTarget);

  if (target?.type === "codex") {
    const prepared = await (dependencies.prepareCodex ?? prepareCodexConnection)({
      env,
      threadId: target.threadId
    });
    if (!prepared.probe.ok) {
      const errorCode = PREFLIGHT_ERROR_CODES.has(prepared.probe.errorCode as NotificationErrorCode)
        ? prepared.probe.errorCode!
        : "codex_app_server_unavailable";
      throw new InputValidationError(
        `Codex notification preflight failed: ${errorCode}. ${preflightRecovery(errorCode)}`
      );
    }
    await closePreflightConnection(prepared);
  }

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

async function closePreflightConnection(prepared: PreparedCodexConnection): Promise<void> {
  try {
    await prepared.client?.close();
  } catch {
    // Target validation succeeded; a best-effort cleanup failure must not block the queued job.
  }
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
