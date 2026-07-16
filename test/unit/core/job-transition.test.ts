import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as transitionApi from "../../../src/core/job-transition.js";
import { readJobSignals } from "../../../src/core/job-signals.js";
import {
  createJobStore,
  readJob,
  resolveJobPaths,
  resolveJobStateFile,
  updateJob
} from "../../../src/core/job-store.js";
import type {
  JobPhase,
  JobStatus,
  JobTransitionFields
} from "../../../src/core/jobs.js";
import { claimDueDelivery, readDeliveries } from "../../../src/notify/outbox.js";

const { appendJobProgress, recoverPendingTransition, transitionJob } = transitionApi;
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function seedJob(status: JobStatus, notification = false): { cwd: string; jobId: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-transition-"));
  tempDirs.push(cwd);
  const job = createJobStore(cwd).create({
    kind: "compose",
    task: "test transitions",
    request: {},
    ...(notification
      ? { notificationTarget: { type: "codex" as const, threadId: "thread-1" } }
      : {})
  });
  if (status !== "queued") {
    updateJob(cwd, job.id, {
      status,
      ...(status === "running"
        ? { phase: "editing", pid: 123, processIdentity: "start-123" }
        : {})
    });
  }
  return { cwd, jobId: job.id };
}

function rawJob(cwd: string, jobId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(resolveJobPaths(cwd, jobId).jobFile, "utf8")) as Record<string, unknown>;
}

function writeRawJob(cwd: string, jobId: string, job: Record<string, unknown>): void {
  fs.writeFileSync(resolveJobPaths(cwd, jobId).jobFile, JSON.stringify(job, null, 2), "utf8");
}

describe("job transitions", () => {
  it.each([
    ["queued", "running"],
    ["queued", "failed"],
    ["queued", "cancelled"],
    ["running", "needs_input"],
    ["running", "blocked"],
    ["running", "completed"],
    ["running", "failed"],
    ["running", "cancelled"],
    ["running", "timeout"]
  ] as const)("allows %s -> %s", async (from, to) => {
    const { cwd, jobId } = seedJob(from);
    const phase: JobPhase | undefined = to === "running" ? "starting" : undefined;

    const result = await transitionJob(cwd, jobId, { status: to, phase, summary: to });

    expect(result.job.status).toBe(to);
    expect(result.signal).toMatchObject({
      jobId,
      kind: to === "running" ? "phase_changed" : to,
      status: to,
      summary: to
    });
    expect(readJobSignals(result.job.signalsFile).signals).toEqual([result.signal]);
  });

  it("rejects terminal to running", async () => {
    const { cwd, jobId } = seedJob("completed");

    await expect(transitionJob(cwd, jobId, {
      status: "running",
      phase: "starting",
      summary: "again"
    })).rejects.toThrow("Illegal job transition completed -> running");
  });

  it("clears phase, pid, and process identity outside running", async () => {
    const { cwd, jobId } = seedJob("running");

    const { job } = await transitionJob(cwd, jobId, {
      status: "completed",
      phase: "finalizing",
      pid: 999,
      processIdentity: "must-not-survive",
      summary: "done"
    });

    expect(job.phase).toBeUndefined();
    expect(job).not.toHaveProperty("phase");
    expect(job.pid).toBeNull();
    expect(job.processIdentity).toBeNull();
    expect(readJob(cwd, jobId)).toMatchObject({
      status: "completed",
      pid: null,
      processIdentity: null
    });
    expect(readJob(cwd, jobId)).not.toHaveProperty("phase");
  });

  it("does not enqueue progress but enqueues one terminal event", async () => {
    const { cwd, jobId } = seedJob("running", true);
    const job = readJob(cwd, jobId)!;

    await appendJobProgress(cwd, jobId, {
      kind: "milestone",
      level: "info",
      summary: "read files"
    });
    expect(readDeliveries(job.notificationOutboxFile)).toEqual([]);

    const result = await transitionJob(cwd, jobId, { status: "completed", summary: "done" });
    expect(result.deliveryCreated).toBe(true);
    expect(readDeliveries(job.notificationOutboxFile)).toHaveLength(1);
  });

  it("never enqueues a running transition", async () => {
    const { cwd, jobId } = seedJob("queued", true);
    const result = await transitionJob(cwd, jobId, {
      status: "running",
      phase: "starting",
      pid: 456,
      processIdentity: "start-456",
      summary: "started"
    });

    expect(result.deliveryCreated).toBe(false);
    expect(readDeliveries(result.job.notificationOutboxFile)).toEqual([]);
  });

  it("rejects attention kinds passed as ordinary progress", async () => {
    const { cwd, jobId } = seedJob("running");

    await expect(appendJobProgress(cwd, jobId, {
      kind: "failed",
      level: "error",
      summary: "not progress"
    } as never)).rejects.toThrow("Attention signal failed must be written by transitionJob");
    expect(readJob(cwd, jobId)?.status).toBe("running");
  });

  it.each([
    ["prepared", "afterIntentPersisted", "prepared", "running", 0],
    ["signal appended", "afterSignalAppended", "prepared", "running", 1],
    ["job finalized", "afterJobFinalized", "finalized", "completed", 1]
  ] as const)(
    "keeps delivery unclaimable when paused after %s and recovers",
    async (_boundary, hook, expectedStage, expectedStatus, expectedSignals) => {
      const { cwd, jobId } = seedJob("running", true);
      const job = readJob(cwd, jobId)!;
      const dependencies = {
        [hook]: () => { throw new Error(`paused:${hook}`); }
      };

      await expect(transitionJob(cwd, jobId, {
        status: "completed",
        summary: "done"
      }, dependencies)).rejects.toThrow(`paused:${hook}`);

      const paused = readJob(cwd, jobId)!;
      expect(paused.status).toBe(expectedStatus);
      expect(paused.pendingTransition?.stage).toBe(expectedStage);
      expect(readJobSignals(job.signalsFile).signals).toHaveLength(expectedSignals);
      expect(await claimDueDelivery(job.notificationOutboxFile, new Date(), 30_000))
        .toBeUndefined();

      const recovered = await recoverPendingTransition(cwd, jobId);
      expect(recovered).toMatchObject({ deliveryCreated: true, job: { status: "completed" } });
      expect(readJob(cwd, jobId)).not.toHaveProperty("pendingTransition");
      expect(await claimDueDelivery(job.notificationOutboxFile, new Date(), 30_000))
        .toMatchObject({ jobId, signalCursor: 1 });
    }
  );

  it("publishes delivery only after the finalized job status is visible", async () => {
    const { cwd, jobId } = seedJob("running", true);
    let observedStatus: JobStatus | undefined;
    let claimedJobId: string | undefined;

    await transitionJob(cwd, jobId, { status: "completed", summary: "done" }, {
      afterDeliveryEnqueued: async () => {
        observedStatus = readJob(cwd, jobId)?.status;
        claimedJobId = (await claimDueDelivery(
          readJob(cwd, jobId)!.notificationOutboxFile,
          new Date(),
          30_000
        ))?.jobId;
      }
    });

    expect(observedStatus).toBe("completed");
    expect(claimedJobId).toBe(jobId);
  });

  it("returns the worker-start trigger when recovery finds an existing delivery", async () => {
    const { cwd, jobId } = seedJob("running", true);

    await expect(transitionJob(cwd, jobId, { status: "completed", summary: "done" }, {
      afterDeliveryEnqueued: () => { throw new Error("after enqueue"); }
    })).rejects.toThrow("after enqueue");
    expect(readDeliveries(readJob(cwd, jobId)!.notificationOutboxFile)).toHaveLength(1);
    expect(readJob(cwd, jobId)?.pendingTransition?.stage).toBe("finalized");

    const recovered = await recoverPendingTransition(cwd, jobId);
    expect(recovered?.deliveryCreated).toBe(true);
    expect(readDeliveries(recovered!.job.notificationOutboxFile)).toHaveLength(1);
  });

  it("recovers the worker trigger after intent clear commits but acknowledgment is lost", async () => {
    const { cwd, jobId } = seedJob("running", true);
    const job = readJob(cwd, jobId)!;

    await expect(transitionJob(cwd, jobId, { status: "completed", summary: "done" }, {
      afterIntentCleared: () => { throw new Error("after clear"); }
    })).rejects.toThrow("after clear");
    expect(readJob(cwd, jobId)).not.toHaveProperty("pendingTransition");
    expect(readJobSignals(job.signalsFile).signals).toHaveLength(1);
    expect(readDeliveries(job.notificationOutboxFile)).toHaveLength(1);

    const recovered = await recoverPendingTransition(cwd, jobId);
    expect(recovered).toMatchObject({
      deliveryCreated: true,
      job: { status: "completed" },
      signal: { cursor: 1, status: "completed" }
    });
    expect(readJobSignals(job.signalsFile).signals).toHaveLength(1);
    expect(readDeliveries(job.notificationOutboxFile)).toHaveLength(1);
  });

  it("does not recover an unacknowledged delivery from a mismatched signal kind", async () => {
    const { cwd, jobId } = seedJob("running", true);
    const job = readJob(cwd, jobId)!;
    await expect(transitionJob(cwd, jobId, { status: "completed", summary: "done" }, {
      afterIntentCleared: () => { throw new Error("after clear"); }
    })).rejects.toThrow("after clear");
    const signal = readJobSignals(job.signalsFile).signals[0];
    fs.writeFileSync(job.signalsFile, `${JSON.stringify({ ...signal, kind: "failed" })}\n`, "utf8");

    expect(await recoverPendingTransition(cwd, jobId)).toBeUndefined();
    expect(readDeliveries(job.notificationOutboxFile)).toHaveLength(1);
  });

  it("does not report a finalized job-file write as failed when state index refresh fails", async () => {
    const { cwd, jobId } = seedJob("running", true);
    const stateFile = resolveJobStateFile(cwd);
    const original = fs.writeFileSync.bind(fs);
    let failed = false;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file, data, options) => {
      if (!failed && String(file).startsWith(`${stateFile}.`) &&
          (rawJob(cwd, jobId).pendingTransition as { stage?: unknown } | undefined)?.stage === "finalized") {
        failed = true;
        throw new Error("state index unavailable");
      }
      return original(file, data, options);
    }) as typeof fs.writeFileSync);

    const result = await transitionJob(cwd, jobId, { status: "completed", summary: "done" });

    expect(failed).toBe(true);
    expect(result).toMatchObject({ deliveryCreated: true, job: { status: "completed" } });
    expect(readJob(cwd, jobId)).not.toHaveProperty("pendingTransition");
    expect(readDeliveries(result.job.notificationOutboxFile)).toHaveLength(1);
  });

  it("recovers a finalized transition after its state index refresh fails", async () => {
    const { cwd, jobId } = seedJob("running", true);
    const stateFile = resolveJobStateFile(cwd);
    const original = fs.writeFileSync.bind(fs);
    let failed = false;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file, data, options) => {
      if (!failed && String(file).startsWith(`${stateFile}.`) &&
          (rawJob(cwd, jobId).pendingTransition as { stage?: unknown } | undefined)?.stage === "finalized") {
        failed = true;
        throw new Error("state index unavailable");
      }
      return original(file, data, options);
    }) as typeof fs.writeFileSync);

    await expect(transitionJob(cwd, jobId, { status: "completed", summary: "done" }, {
      afterJobFinalized: () => { throw new Error("worker stopped"); }
    })).rejects.toThrow("worker stopped");
    expect(readJob(cwd, jobId)).toMatchObject({
      status: "completed",
      pendingTransition: { stage: "finalized" }
    });

    const recovered = await recoverPendingTransition(cwd, jobId);
    expect(recovered).toMatchObject({ deliveryCreated: true, job: { status: "completed" } });
    expect(readDeliveries(recovered!.job.notificationOutboxFile)).toHaveLength(1);
  });

  it.each([
    ["version", (pending: Record<string, unknown>) => { pending.version = 2; }],
    ["stage", (pending: Record<string, unknown>) => { pending.stage = "unknown"; }],
    ["from status", (pending: Record<string, unknown>) => { pending.fromStatus = "completed"; }],
    ["target status", (pending: Record<string, unknown>) => { pending.status = "queued"; }],
    ["summary", (pending: Record<string, unknown>) => { pending.summary = 42; }],
    ["cursor", (pending: Record<string, unknown>) => { pending.signalCursor = 0; }],
    ["signal timestamp", (pending: Record<string, unknown>) => { pending.signalCreatedAt = "invalid"; }],
    ["normalized phase", (pending: Record<string, unknown>) => { pending.phase = "reviewing"; }],
    ["normalized pid", (pending: Record<string, unknown>) => { pending.pid = 999; }],
    ["startedAt", (pending: Record<string, unknown>) => { pending.startedAt = "invalid"; }],
    ["completedAt", (pending: Record<string, unknown>) => { pending.completedAt = 42; }],
    ["sessionId", (pending: Record<string, unknown>) => { pending.sessionId = 42; }],
    ["changedFiles", (pending: Record<string, unknown>) => { pending.changedFiles = [42]; }],
    ["verification", (pending: Record<string, unknown>) => { pending.verification = [{}]; }],
    ["execution callback", (pending: Record<string, unknown>) => {
      pending.executionCallback = { invocationId: "i", outcome: "unknown" };
    }],
    ["report paths", (pending: Record<string, unknown>) => { pending.reportPaths = { json: 42 }; }],
    ["error", (pending: Record<string, unknown>) => { pending.error = 42; }],
    ["error code", (pending: Record<string, unknown>) => { pending.errorCode = 42; }],
    ["request hash", (pending: Record<string, unknown>) => { pending.requestHash = "invalid"; }]
  ] as const)("rejects malformed pending intent %s without recovery", async (_name, mutate) => {
    const { cwd, jobId } = seedJob("running", true);
    await expect(transitionJob(cwd, jobId, {
      status: "completed",
      summary: "winner"
    }, {
      afterIntentPersisted: () => { throw new Error("prepared"); }
    })).rejects.toThrow("prepared");
    const job = rawJob(cwd, jobId);
    mutate(job.pendingTransition as Record<string, unknown>);
    writeRawJob(cwd, jobId, job);

    expect(() => readJob(cwd, jobId)).toThrow(`Malformed job file for job id: ${jobId}`);
    await expect(recoverPendingTransition(cwd, jobId)).rejects.toThrow("Malformed job file");
    expect((rawJob(cwd, jobId).status)).toBe("running");
    expect(readJobSignals(String(job.signalsFile)).signals).toEqual([]);
    expect(readDeliveries(String(job.notificationOutboxFile))).toEqual([]);
  });

  it.each([
    ["error", { error: "competitor error" }],
    ["verification", { verification: [{ command: "npm test", exitCode: 1, passed: false }] }],
    ["execution callback", {
      executionCallback: { invocationId: "other", outcome: "error" as const, error: "bad" }
    }],
    ["report paths", { reportPaths: { json: "other.json" } }],
    ["changed files", { changedFiles: ["other.ts"] }],
    ["phase", { phase: "reviewing" as const }],
    ["pid", { pid: 999 }]
  ] as const)("recovers the winner then rejects a competitor differing in %s", async (_name, patch) => {
    const { cwd, jobId } = seedJob("running", true);
    const winner: JobTransitionFields = {
      status: "completed",
      summary: "same",
      phase: "finalizing",
      pid: 321,
      error: "winner error",
      verification: [{ command: "npm test", exitCode: 0, passed: true }],
      executionCallback: { invocationId: "winner", outcome: "completed" },
      reportPaths: { json: "winner.json", markdown: "winner.md" },
      changedFiles: ["winner.ts"]
    };
    await expect(transitionJob(cwd, jobId, winner, {
      afterIntentPersisted: () => { throw new Error("winner prepared"); }
    })).rejects.toThrow("winner prepared");

    await expect(transitionJob(cwd, jobId, { ...winner, ...patch }))
      .rejects.toThrow("Illegal job transition completed -> completed");

    const stored = readJob(cwd, jobId)!;
    expect(stored.status).toBe("completed");
    expect(stored.error).toBe("winner error");
    expect(stored.changedFiles).toEqual(["winner.ts"]);
    expect(stored.reportPaths).toEqual({ json: "winner.json", markdown: "winner.md" });
    expect(stored.executionCallback).toMatchObject({ invocationId: "winner" });
  });

  it("matching retry recovers the same complete patch", async () => {
    const { cwd, jobId } = seedJob("running", true);
    const transition: JobTransitionFields = {
      status: "failed",
      summary: "same",
      error: "failure",
      errorCode: "process_failed",
      changedFiles: ["src/a.ts"]
    };
    await expect(transitionJob(cwd, jobId, transition, {
      afterIntentPersisted: () => { throw new Error("prepared"); }
    })).rejects.toThrow("prepared");

    const recovered = await transitionJob(cwd, jobId, transition);
    expect(recovered.job).toMatchObject(transition);
    expect(recovered.deliveryCreated).toBe(true);
  });
});
