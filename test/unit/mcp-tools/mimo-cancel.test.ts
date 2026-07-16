import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobStore, readJob, updateJob } from "../../../src/core/job-store.js";
import { mimoCancel } from "../../../src/codex/tools.js";
import { readJobSignals } from "../../../src/core/job-signals.js";
import { readDeliveries } from "../../../src/notify/outbox.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-cancel-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const cwd of tempDirs.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

describe("mimo_cancel", () => {
  it("transitions a running job, terminates only its owned process, and starts notification delivery", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      task: "Run dev",
      request: {},
      notificationTarget: { type: "codex", threadId: "thread-1" }
    });
    updateJob(cwd, job.id, {
      status: "running", phase: "investigating", pid: 456, processIdentity: "win32:456"
    });
    const terminateProcess = vi.fn().mockReturnValue({ status: "terminated", evidence: "done" });
    const spawnNotificationWorker = vi.fn().mockReturnValue(999);

    const result = await mimoCancel({ cwd, jobId: job.id }, {
      terminateProcess, spawnNotificationWorker
    });

    expect(result.status).toBe("cancelled");
    expect(terminateProcess).toHaveBeenCalledWith(456, "win32:456");
    expect(spawnNotificationWorker).toHaveBeenCalledTimes(1);
    expect(readJob(cwd, job.id)).toMatchObject({
      status: "cancelled", pid: null, processIdentity: null
    });
    expect(readJobSignals(job.signalsFile).signals.at(-1)).toMatchObject({
      kind: "cancelled", status: "cancelled", summary: `Cancelled ${job.id}.`
    });
    expect(readDeliveries(job.notificationOutboxFile)).toHaveLength(1);
  });

  it("does not start a notification worker when transition creates no delivery", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "review", task: "Review", request: {} });
    const spawnNotificationWorker = vi.fn();

    await mimoCancel({ cwd, jobId: job.id }, {
      terminateProcess: vi.fn(), spawnNotificationWorker
    });

    expect(spawnNotificationWorker).not.toHaveBeenCalled();
  });

  it("is idempotent for an already cancelled job without duplicating signals or delivery", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "plan", task: "Plan", request: {},
      notificationTarget: { type: "codex", threadId: "thread-1" }
    });
    const deps = {
      terminateProcess: vi.fn(),
      spawnNotificationWorker: vi.fn().mockReturnValue(999)
    };
    await mimoCancel({ cwd, jobId: job.id }, deps);
    const firstSignalCount = readJobSignals(job.signalsFile).signals.length;
    const firstDeliveryCount = readDeliveries(job.notificationOutboxFile).length;

    const repeated = await mimoCancel({ cwd, jobId: job.id }, deps);

    expect(repeated.status).toBe("cancelled");
    expect(readJobSignals(job.signalsFile).signals).toHaveLength(firstSignalCount);
    expect(readDeliveries(job.notificationOutboxFile)).toHaveLength(firstDeliveryCount);
    expect(deps.spawnNotificationWorker).toHaveBeenCalledTimes(1);
  });

  it("rejects non-cancellable terminal jobs and missing jobs", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "plan", task: "Plan", request: {} });
    updateJob(cwd, job.id, { status: "completed" });
    await expect(mimoCancel({ cwd, jobId: job.id })).rejects.toThrow("cannot be cancelled");
    await expect(mimoCancel({ cwd, jobId: "missing" })).rejects.toThrow("No job found");
  });
});
