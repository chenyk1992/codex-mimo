import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputValidationError } from "../../../src/core/input-validation.js";
import { launchJob, toJobReceipt } from "../../../src/core/job-launcher.js";
import { createJobStore, readJob } from "../../../src/core/job-store.js";
import { readDeliveries } from "../../../src/notify/outbox.js";
import type { CodexCommandProbe } from "../../../src/notify/codex-command.js";

const workspaces: string[] = [];

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-launcher-"));
  workspaces.push(cwd);
  return cwd;
}

function okProbe(): CodexCommandProbe {
  return { ok: true, source: "path" };
}

afterEach(() => {
  for (const cwd of workspaces.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

describe("launchJob", () => {
  it("probes Codex after resolve and before persist/spawn", async () => {
    const cwd = workspace();
    const order: string[] = [];
    const env = { CODEX_THREAD_ID: "thread-1", CODEX_MIMO_CODEX_BIN: "C:\\safe\\codex.exe" };
    const receipt = await launchJob({
      kind: "plan",
      cwd,
      task: "Plan it",
      request: { cwd, task: "Plan it" },
      notify: { type: "codex", threadId: "thread-1" }
    }, {
      env,
      resolveTarget(input, resolvedEnv) {
        order.push("resolve");
        expect(fs.existsSync(path.join(cwd, ".codex-mimo", "jobs"))).toBe(false);
        expect(input).toEqual({ type: "codex", threadId: "thread-1" });
        expect(resolvedEnv.CODEX_THREAD_ID).toBe("thread-1");
        return { type: "codex", threadId: "thread-1" };
      },
      async probeCodex(options) {
        order.push("probe");
        expect(fs.existsSync(path.join(cwd, ".codex-mimo", "jobs"))).toBe(false);
        expect(options?.env).toBe(env);
        return okProbe();
      },
      createJob(cwdArg, input) {
        order.push("persist");
        return createJobStore(cwdArg).create(input);
      },
      spawnJobSupervisor: vi.fn(() => {
        order.push("spawn");
        return 123;
      })
    });

    expect(order).toEqual(["resolve", "probe", "persist", "spawn"]);
    expect(receipt).toEqual({
      jobId: expect.any(String),
      kind: "plan",
      status: "queued",
      actions: {
        status: "mimo_status",
        events: "mimo_events",
        result: "mimo_result",
        cancel: "mimo_cancel"
      }
    });
    expect(readJob(cwd, receipt.jobId)?.notificationTarget).toEqual({
      type: "codex",
      threadId: "thread-1"
    });
  });

  it.each([
    [
      "codex_cli_not_found",
      "Set CODEX_MIMO_CODEX_BIN to a runnable standalone Codex CLI, restart Codex Desktop, then run mimo_healthcheck."
    ],
    [
      "codex_cli_not_executable",
      "Set CODEX_MIMO_CODEX_BIN to a standalone Codex CLI outside protected WindowsApps packages, restart Codex Desktop, then run mimo_healthcheck."
    ],
    [
      "codex_app_server_unavailable",
      "The selected Codex CLI did not pass its launchability check. Run mimo_healthcheck and verify CODEX_MIMO_CODEX_BIN before retrying."
    ]
  ] as const)("rejects %s before persistence with safe recovery", async (errorCode, recovery) => {
    const cwd = workspace();
    const createJob = vi.fn();
    const spawnJobSupervisor = vi.fn();
    const probeCodex = vi.fn().mockResolvedValue({
      ok: false,
      source: "configured",
      errorCode,
      version: "should-not-leak"
    });

    await expect(launchJob({
      kind: "plan",
      cwd,
      task: "Plan it",
      request: { cwd, task: "Plan it" },
      notify: { type: "codex", threadId: "thread-1" }
    }, {
      env: { CODEX_MIMO_CODEX_BIN: "C:\\private\\codex.exe" },
      probeCodex,
      createJob,
      spawnJobSupervisor
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(InputValidationError);
      expect((error as Error).message).toBe(
        `Codex notification preflight failed: ${errorCode}. ${recovery}`
      );
      expect((error as Error).message).not.toContain("C:\\private\\codex.exe");
      expect((error as Error).message).not.toContain("private");
      expect((error as Error).message).not.toContain("should-not-leak");
      return true;
    });

    expect(probeCodex).toHaveBeenCalledOnce();
    expect(createJob).not.toHaveBeenCalled();
    expect(spawnJobSupervisor).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(cwd, ".codex-mimo", "jobs"))).toBe(false);
  });

  it("does not probe Codex for webhook notifications", async () => {
    const cwd = workspace();
    const probeCodex = vi.fn();
    const receipt = await launchJob({
      kind: "plan",
      cwd,
      task: "Plan it",
      request: { cwd, task: "Plan it" },
      notify: { type: "webhook", url: "https://example.test/hook", secretEnv: "HOOK_SECRET" }
    }, {
      env: {},
      probeCodex,
      spawnJobSupervisor: vi.fn().mockReturnValue(123)
    });

    expect(probeCodex).not.toHaveBeenCalled();
    expect(receipt.status).toBe("queued");
    expect(readJob(cwd, receipt.jobId)?.notificationTarget).toEqual({
      type: "webhook",
      url: "https://example.test/hook",
      secretEnv: "HOOK_SECRET"
    });
  });

  it("does not probe Codex when notify is omitted", async () => {
    const cwd = workspace();
    const probeCodex = vi.fn();
    const receipt = await launchJob({
      kind: "review",
      cwd,
      task: "Review HEAD",
      request: { cwd, base: "HEAD" }
    }, {
      env: { CODEX_THREAD_ID: "ambient-thread" },
      probeCodex,
      spawnJobSupervisor: vi.fn().mockReturnValue(123)
    });

    expect(probeCodex).not.toHaveBeenCalled();
    expect(readJob(cwd, receipt.jobId)?.notificationTarget).toBeUndefined();
  });

  it("stores a frozen Codex target for an explicit Codex launch with threadId", async () => {
    const cwd = workspace();
    const spawnJobSupervisor = vi.fn().mockReturnValue(123);
    const receipt = await launchJob({
      kind: "plan",
      cwd,
      task: "Plan it",
      request: { cwd, task: "Plan it" },
      notify: { type: "codex", threadId: "task-123" }
    }, {
      env: { CODEX_THREAD_ID: "task-123" },
      probeCodex: async () => okProbe(),
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
    const probeCodex = vi.fn();

    await expect(launchJob({
      kind: "plan",
      cwd,
      task: "Plan it",
      request: { cwd, task: "Plan it" },
      notify: { type: "codex" } as never
    }, {
      env: {},
      probeCodex,
      createJob,
      spawnJobSupervisor
    })).rejects.toThrow("Codex notification requires explicit threadId");

    expect(probeCodex).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
    expect(spawnJobSupervisor).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(cwd, ".codex-mimo", "jobs"))).toBe(false);
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
      probeCodex: async () => okProbe(),
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
