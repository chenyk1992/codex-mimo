import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobStore, readJob, resolveJobPaths, updateJob } from "../../../src/core/job-store.js";
import { mimoCancel } from "../../../src/codex/tools.js";
import { readJobSignals } from "../../../src/core/job-signals.js";
import { readDeliveries } from "../../../src/notify/outbox.js";
import { withProcessLock } from "../../../src/core/process-lock.js";

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
    const stored = readJob(cwd, job.id);
    expect(stored).toMatchObject({ status: "cancelled", pid: null, processIdentity: null });
    expect(stored).not.toHaveProperty("cancellationRequestedAt");
    expect(readJobSignals(job.signalsFile).signals.at(-1)).toMatchObject({
      kind: "cancelled", status: "cancelled", summary: "MiMoCode job was cancelled."
    });
    expect(readDeliveries(job.notificationOutboxFile)).toHaveLength(1);
  });

  it("keeps an unconfirmed owned process nonterminal without cancellation attention", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "implement",
      task: "Keep process safe",
      request: {},
      notificationTarget: { type: "codex", threadId: "thread-1" }
    });
    updateJob(cwd, job.id, {
      status: "running",
      phase: "editing",
      pid: 456,
      processIdentity: "win32:456"
    });

    await expect(mimoCancel({ cwd, jobId: job.id }, {
      terminateProcess: vi.fn(() => ({ status: "unconfirmed", evidence: "tree still live" })),
      spawnNotificationWorker: vi.fn()
    })).rejects.toThrow(/could not be confirmed.*tree still live/i);

    expect(readJob(cwd, job.id)).toMatchObject({
      status: "running",
      pid: 456,
      processIdentity: "win32:456",
      cancellationRequestedAt: expect.any(String)
    });
    expect(readJobSignals(job.signalsFile).signals).toHaveLength(0);
    expect(readDeliveries(job.notificationOutboxFile)).toHaveLength(0);
  });

  it("cancels a queued job without invoking process termination", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "review", task: "Review", request: {} });
    const terminateProcess = vi.fn();

    const result = await mimoCancel({ cwd, jobId: job.id }, { terminateProcess });

    expect(result.status).toBe("cancelled");
    expect(terminateProcess).not.toHaveBeenCalled();
  });

  it("returns an explicit pending result while a live worker owns process shutdown", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "implement", task: "Run", request: {} });
    updateJob(cwd, job.id, {
      status: "running",
      phase: "editing",
      pid: 456,
      processIdentity: "start-456"
    });
    const terminateProcess = vi.fn();
    const ownership = `${resolveJobPaths(cwd, job.id).jobFile}.worker-ownership`;

    const result = await withProcessLock(ownership, () => mimoCancel(
      { cwd, jobId: job.id },
      {
        terminateProcess,
        waitForCancellation: async () => readJob(cwd, job.id)!
      }
    ));

    expect(result).toMatchObject({ status: "running", cancellationRequested: true });
    expect(terminateProcess).not.toHaveBeenCalled();
    expect(readJobSignals(job.signalsFile).signals).toHaveLength(0);
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

  it("cascades cancel from a chain root to the live slice child and pending slices", async () => {
    const cwd = tempWorkspace();
    const { bootstrapWriteJobChain } = await import("../../../src/core/job-definitions.js");
    const { readJobChain } = await import("../../../src/core/job-chain.js");
    const { updateJobAuthoritative } = await import("../../../src/core/job-store.js");
    const { transitionJob } = await import("../../../src/core/job-transition.js");

    const acceptance = {
      build: ["npm run build"],
      test: ["npm test -- focused.test.ts"]
    };
    const root = createJobStore(cwd).create({
      kind: "implement",
      task: "Implement feature",
      request: {
        cwd,
        task: "Implement feature",
        allowWrite: true,
        acceptance,
        batchMode: "sliced"
      },
      notificationTarget: { type: "codex", threadId: "thread-root" }
    });
    await updateJobAuthoritative(cwd, root.id, { status: "running", phase: "editing" });
    const boot = await bootstrapWriteJobChain(readJob(cwd, root.id)!, {
      spawnJobSupervisor: () => 1,
      captureRepositoryFingerprint: async () => "fp-test",
      planSliceManifest: async (input) => ({
        ok: true,
        manifest: {
          version: 1 as const,
          chainId: input.chainId,
          objective: "Implement feature",
          repositoryFingerprint: "fp-test",
          slices: [
            {
              id: "slice-1",
              title: "Slice 1",
              objective: "Do work for slice-1",
              dependsOn: [],
              contextFiles: [],
              allowedPaths: ["src/**"],
              acceptance
            },
            {
              id: "slice-2",
              title: "Slice 2",
              objective: "Do work for slice-2",
              dependsOn: ["slice-1"],
              contextFiles: [],
              allowedPaths: ["src/**"],
              acceptance
            }
          ]
        }
      })
    });
    expect(boot.status).toBe("bootstrapped");
    if (boot.status !== "bootstrapped") throw new Error("bootstrap failed");

    await transitionJob(cwd, boot.childJobId, {
      status: "running",
      summary: "running slice 1",
      phase: "editing",
      pid: 777,
      processIdentity: "win32:777"
    });

    const terminateProcess = vi.fn().mockReturnValue({ status: "terminated", evidence: "done" });
    const result = await mimoCancel(
      { cwd, jobId: boot.root.id },
      { terminateProcess, spawnNotificationWorker: vi.fn() }
    );

    expect(result.status).toBe("cancelled");
    expect(readJob(cwd, boot.childJobId)?.status).toBe("cancelled");
    expect(terminateProcess).toHaveBeenCalledWith(777, "win32:777");
    const chain = readJobChain(cwd, boot.chainId)!;
    expect(chain.sliceStates["slice-1"]).toBe("cancelled");
    expect(chain.sliceStates["slice-2"]).toBe("cancelled");
  });
});
