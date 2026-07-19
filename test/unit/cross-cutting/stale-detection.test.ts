import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJobStore,
  listJobs,
  readJob,
  updateJob
} from "../../../src/core/job-store.js";
import { recoverStaleQueuedJobs } from "../../../src/core/job-recovery.js";
import { readJobSignals } from "../../../src/core/job-signals.js";
import { readDeliveries } from "../../../src/notify/outbox.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-xcut-stale-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("job stale recovery", () => {
  it("keeps listJobs read-only for stale queued jobs", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", workflow: "dev", task: "Stale task", request: {} });

    expect(listJobs(cwd).map((candidate) => candidate.id)).toContain(job.id);
    expect(readJob(cwd, job.id)?.status).toBe("queued");
    expect(readJobSignals(job.signalsFile).signals).toHaveLength(0);
  });

  it("fails stale queued jobs through one attention transition and starts delivery", async () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({
      kind: "compose",
      task: "Stale task",
      request: {},
      notificationTarget: { type: "codex", threadId: "frozen-thread" }
    });
    const spawnNotificationWorker = vi.fn(() => 123);

    const failed = await recoverStaleQueuedJobs(cwd, {
      staleThresholdMs: 0,
      spawnNotificationWorker
    });

    expect(failed).toHaveLength(1);
    expect(failed[0].job.id).toBe(job.id);
    expect(failed[0].job.status).toBe("failed");
    expect(failed[0].job.errorCode).toBe("stale_queued");
    expect(failed[0].job.error).toBe("MiMoCode job stayed queued too long.");
    expect(failed[0].job.summary).toBe("MiMoCode job stayed queued too long.");

    const stored = readJob(cwd, job.id);
    expect(stored?.status).toBe("failed");
    expect(readJobSignals(job.signalsFile).signals).toHaveLength(1);
    expect(readJobSignals(job.signalsFile).signals[0]).toMatchObject({
      kind: "failed",
      status: "failed"
    });
    expect(readDeliveries(job.notificationOutboxFile)).toEqual([
      expect.objectContaining({
        jobId: job.id,
        target: { type: "codex", threadId: "frozen-thread" }
      })
    ]);
    expect(spawnNotificationWorker).toHaveBeenCalledOnce();
  });

  it("is idempotent when concurrent recovery scans the same stale queued job", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "plan",
      task: "Stale plan",
      request: {},
      notificationTarget: { type: "webhook", url: "https://example.test/hook", secretEnv: "HOOK_SECRET" }
    });
    const spawnNotificationWorker = vi.fn(() => 123);

    await Promise.all([
      recoverStaleQueuedJobs(cwd, { staleThresholdMs: 0, spawnNotificationWorker }),
      recoverStaleQueuedJobs(cwd, { staleThresholdMs: 0, spawnNotificationWorker })
    ]);

    expect(readJobSignals(job.signalsFile).signals).toHaveLength(1);
    expect(readDeliveries(job.notificationOutboxFile)).toHaveLength(1);
    expect(spawnNotificationWorker).toHaveBeenCalledOnce();
  });

  it("running jobs are not affected by stale detection", async () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", workflow: "dev", task: "Running task", request: {} });
    updateJob(cwd, job.id, {
      status: "running", phase: "editing", pid: 42, processIdentity: "start-42"
    });

    const failed = await recoverStaleQueuedJobs(cwd, { staleThresholdMs: 0 });

    expect(failed).toHaveLength(0);
    const stored = readJob(cwd, job.id);
    expect(stored?.status).toBe("running");
  });

  it("completed jobs are not affected by stale detection", async () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", workflow: "dev", task: "Done task", request: {} });
    updateJob(cwd, job.id, { status: "completed", phase: undefined });

    const failed = await recoverStaleQueuedJobs(cwd, { staleThresholdMs: 0 });

    expect(failed).toHaveLength(0);
    const stored = readJob(cwd, job.id);
    expect(stored?.status).toBe("completed");
  });

  it("recent queued jobs are not marked stale", async () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    store.create({ kind: "compose", workflow: "dev", task: "Fresh", request: {} });

    const failed = await recoverStaleQueuedJobs(cwd, { staleThresholdMs: 300_000 });

    expect(failed).toHaveLength(0);
  });
});
