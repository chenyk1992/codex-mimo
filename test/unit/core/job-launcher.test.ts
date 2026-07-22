import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchJob, toJobReceipt } from "../../../src/core/job-launcher.js";
import { createJobStore, readJob } from "../../../src/core/job-store.js";
import { readDeliveries } from "../../../src/notify/outbox.js";

const workspaces: string[] = [];

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-launcher-"));
  workspaces.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const cwd of workspaces.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

describe("launchJob", () => {
  it("freezes the resolved target before persisting the queued job", async () => {
    const cwd = workspace();
    const order: string[] = [];
    const receipt = await launchJob({
      kind: "plan",
      cwd,
      task: "Plan it",
      request: { cwd, task: "Plan it" },
      notify: { type: "codex" }
    }, {
      env: { CODEX_THREAD_ID: "thread-1" },
      resolveTarget(input, env) {
        order.push("resolve");
        expect(fs.existsSync(path.join(cwd, ".codex-mimo", "jobs"))).toBe(false);
        expect(input).toEqual({ type: "codex" });
        expect(env.CODEX_THREAD_ID).toBe("thread-1");
        return { type: "codex", threadId: "thread-1" };
      },
      createJob(cwdArg, input) {
        order.push("persist");
        return createJobStore(cwdArg).create(input);
      },
      spawnJobSupervisor: vi.fn().mockReturnValue(123)
    });

    expect(order).toEqual(["resolve", "persist"]);
    expect(readJob(cwd, receipt.jobId)?.notificationTarget).toEqual({
      type: "codex",
      threadId: "thread-1"
    });
  });

  it("stores a frozen Codex target for an explicit Codex launch with task-scoped thread ID", async () => {
    const cwd = workspace();
    const spawnJobSupervisor = vi.fn().mockReturnValue(123);
    const receipt = await launchJob({
      kind: "plan",
      cwd,
      task: "Plan it",
      request: { cwd, task: "Plan it" },
      notify: { type: "codex" }
    }, {
      env: { CODEX_THREAD_ID: "task-123" },
      spawnJobSupervisor
    });

    expect(spawnJobSupervisor).toHaveBeenCalledOnce();
    expect(readJob(cwd, receipt.jobId)?.notificationTarget).toEqual({
      type: "codex",
      threadId: "task-123"
    });
  });

  it("does not create a job or spawn when explicit Codex target resolution fails", async () => {
    const cwd = workspace();
    const createJob = vi.fn();
    const spawnJobSupervisor = vi.fn();

    await expect(launchJob({
      kind: "plan",
      cwd,
      task: "Plan it",
      request: { cwd, task: "Plan it" },
      notify: { type: "codex" }
    }, {
      env: {},
      createJob,
      spawnJobSupervisor
    })).rejects.toThrow("Codex notification requires threadId");

    expect(createJob).not.toHaveBeenCalled();
    expect(spawnJobSupervisor).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(cwd, ".codex-mimo", "jobs"))).toBe(false);
  });

  it("persists no target when neither explicit notify nor CODEX_THREAD_ID exists", async () => {
    const cwd = workspace();
    const receipt = await launchJob({
      kind: "review",
      cwd,
      task: "Review HEAD",
      request: { cwd, base: "HEAD" }
    }, { env: {}, spawnJobSupervisor: vi.fn().mockReturnValue(123) });

    expect(readJob(cwd, receipt.jobId)?.notificationTarget).toBeUndefined();
  });

  it.each([
    { type: "codex" as const, threadId: "thread-2" },
    { type: "webhook" as const, url: "https://example.test/hook", secretEnv: "HOOK_SECRET" }
  ])("persists failed, enqueues $type notification, and starts dispatch when the owner spawn throws", async (notify) => {
    const cwd = workspace();
    const launchError = new Error("spawn denied");
    const spawnNotificationWorker = vi.fn().mockReturnValue(456);
    await expect(launchJob({
      kind: "plan",
      cwd,
      task: "Plan it",
      request: { cwd, task: "Plan it" },
      notify
    }, {
      env: {},
      spawnJobSupervisor: () => { throw launchError; },
      spawnNotificationWorker
    })).rejects.toBe(launchError);

    const files = fs.readdirSync(path.join(cwd, ".codex-mimo", "jobs"));
    const jobId = files.find((file) => /^plan-.*\.json$/.test(file))!.replace(/\.json$/, "");
    const job = readJob(cwd, jobId)!;
    expect(job).toMatchObject({
      status: "failed",
      pid: null,
      processIdentity: null,
      summary: "MiMoCode job failed.",
      error: "MiMoCode job failed.",
      errorCode: "worker_spawn_failed"
    });
    expect(readDeliveries(job.notificationOutboxFile)).toHaveLength(1);
    expect(spawnNotificationWorker).toHaveBeenCalledOnce();
    expect(spawnNotificationWorker).toHaveBeenCalledWith(cwd);
  });

  it("does not return a queued receipt when spawn returns no PID", async () => {
    const cwd = workspace();
    await expect(launchJob({
      kind: "review",
      cwd,
      task: "Review it",
      request: { cwd, base: "HEAD" }
    }, { env: {}, spawnJobSupervisor: () => 0 })).rejects.toThrow(
      "Job supervisor spawn did not return a process ID."
    );

    const jobFile = fs.readdirSync(path.join(cwd, ".codex-mimo", "jobs"))
      .find((file) => /^review-.*\.json$/.test(file))!;
    expect(readJob(cwd, jobFile.replace(/\.json$/, ""))?.status).toBe("failed");
  });

  it("returns immediately without waiting for worker completion", async () => {
    const cwd = workspace();
    let workerFinished = false;
    const receipt = await launchJob({
      kind: "fix-ci",
      cwd,
      task: "Fix CI",
      request: { cwd, file: "ci.log" }
    }, {
      env: {},
      spawnJobSupervisor: () => {
        setTimeout(() => { workerFinished = true; }, 50);
        return 123;
      }
    });

    expect(receipt.status).toBe("queued");
    expect(workerFinished).toBe(false);
  });

  it("requires explicit write authorization for implement jobs", async () => {
    const cwd = workspace();
    await expect(launchJob({
      kind: "implement",
      cwd,
      task: "Build it",
      request: { cwd, task: "Build it", allowWrite: false }
    }, { env: {}, spawnJobSupervisor: vi.fn() })).rejects.toThrow("allowWrite=true");
    expect(fs.existsSync(path.join(cwd, ".codex-mimo", "jobs"))).toBe(false);
  });
});

describe("toJobReceipt", () => {
  it("returns only the stable receipt contract", async () => {
    const cwd = workspace();
    const receipt = await launchJob({
      kind: "compose",
      cwd,
      task: "Compose it",
      request: { cwd, workflow: "dev", task: "Compose it" }
    }, { env: {}, spawnJobSupervisor: vi.fn().mockReturnValue(123) });
    const job = readJob(cwd, receipt.jobId)!;
    expect(toJobReceipt(job)).toEqual({
      jobId: job.id,
      kind: "compose",
      status: "queued",
      actions: {
        status: "mimo_status",
        events: "mimo_events",
        result: "mimo_result",
        cancel: "mimo_cancel"
      }
    });
  });
});
