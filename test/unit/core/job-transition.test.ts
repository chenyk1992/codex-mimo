import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as transitionApi from "../../../src/core/job-transition.js";
import { readJobSignals } from "../../../src/core/job-signals.js";
import { createJobStore, readJob, updateJob } from "../../../src/core/job-store.js";
import type { JobPhase, JobStatus } from "../../../src/core/jobs.js";
import { readDeliveries } from "../../../src/notify/outbox.js";

const { appendJobProgress, transitionJob } = transitionApi;

const tempDirs: string[] = [];

afterEach(() => {
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
      ...(status === "running" ? { phase: "editing", pid: 123 } : {})
    });
  }
  return { cwd, jobId: job.id };
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
  ] as const)("allows %s -> %s", (from, to) => {
    const { cwd, jobId } = seedJob(from);
    const phase: JobPhase | undefined = to === "running" ? "starting" : undefined;

    const result = transitionJob(cwd, jobId, { status: to, phase, summary: to });

    expect(result.job.status).toBe(to);
    expect(result.signal).toMatchObject({
      jobId,
      kind: to === "running" ? "phase_changed" : to,
      status: to,
      summary: to
    });
    expect(readJobSignals(result.job.signalsFile).signals).toEqual([result.signal]);
  });

  it("rejects terminal to running", () => {
    const { cwd, jobId } = seedJob("completed");

    expect(() => transitionJob(cwd, jobId, {
      status: "running",
      phase: "starting",
      summary: "again"
    })).toThrow("Illegal job transition completed -> running");
  });

  it("clears phase and pid outside running", () => {
    const { cwd, jobId } = seedJob("running");

    const { job } = transitionJob(cwd, jobId, {
      status: "completed",
      phase: "finalizing",
      pid: 999,
      summary: "done"
    });

    expect(job.phase).toBeUndefined();
    expect(job).not.toHaveProperty("phase");
    expect(job.pid).toBeNull();
    expect(readJob(cwd, jobId)).toMatchObject({ status: "completed", pid: null });
    expect(readJob(cwd, jobId)).not.toHaveProperty("phase");
  });

  it("does not enqueue progress but enqueues one terminal event", () => {
    const { cwd, jobId } = seedJob("running", true);
    const job = readJob(cwd, jobId)!;

    appendJobProgress(cwd, jobId, {
      kind: "milestone",
      level: "info",
      summary: "read files"
    });
    expect(readDeliveries(job.notificationOutboxFile)).toEqual([]);

    const result = transitionJob(cwd, jobId, { status: "completed", summary: "done" });
    expect(result.deliveryCreated).toBe(true);
    expect(readDeliveries(job.notificationOutboxFile)).toHaveLength(1);
  });

  it("never enqueues a running transition", () => {
    const { cwd, jobId } = seedJob("queued", true);
    const result = transitionJob(cwd, jobId, {
      status: "running",
      phase: "starting",
      pid: 456,
      summary: "started"
    });

    expect(result.deliveryCreated).toBe(false);
    expect(readDeliveries(result.job.notificationOutboxFile)).toEqual([]);
  });

  it("rejects attention kinds passed as ordinary progress", () => {
    const { cwd, jobId } = seedJob("running");

    expect(() => appendJobProgress(cwd, jobId, {
      kind: "failed",
      level: "error",
      summary: "not progress"
    } as never)).toThrow("Attention signal failed must be written by transitionJob");
    expect(readJob(cwd, jobId)?.status).toBe("running");
  });

  it.each([
    ["after durable intent", {
      afterIntentPersisted: () => { throw new Error("after intent"); }
    }],
    ["during signal append", {
      appendSignal: (file: string) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, "{\"partial\"", "utf8");
        throw new Error("signal append");
      }
    }],
    ["during outbox enqueue", {
      enqueueDelivery: (file: string) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, "{\"partial\"", "utf8");
        throw new Error("outbox enqueue");
      }
    }],
    ["before final state commit", {
      beforeFinalCommit: () => { throw new Error("before commit"); }
    }]
  ] as const)("recovers idempotently from failure %s", (_boundary, dependencies) => {
    const { cwd, jobId } = seedJob("running", true);
    const transitionWithDeps = transitionJob as unknown as (
      cwd: string,
      jobId: string,
      transition: { status: "completed"; summary: string },
      dependencies: typeof dependencies
    ) => unknown;

    expect(() => transitionWithDeps(cwd, jobId, {
      status: "completed",
      summary: "done"
    }, dependencies)).toThrow();

    const pending = readJob(cwd, jobId) as unknown as {
      status: JobStatus;
      pendingTransition?: { status: JobStatus; signalCursor: number };
      signalsFile: string;
      notificationOutboxFile: string;
    };
    expect(pending.status).toBe("running");
    expect(pending.pendingTransition).toMatchObject({ status: "completed", signalCursor: 1 });

    const recover = transitionApi.recoverPendingTransition as unknown as (
      cwd: string,
      jobId: string
    ) => { job: { status: JobStatus; pendingTransition?: unknown } } | undefined;
    expect(recover(cwd, jobId)?.job.status).toBe("completed");
    expect(readJob(cwd, jobId)).not.toHaveProperty("pendingTransition");
    expect(readJobSignals(pending.signalsFile).signals).toHaveLength(1);
    expect(readDeliveries(pending.notificationOutboxFile)).toHaveLength(1);

    expect(recover(cwd, jobId)).toBeUndefined();
    expect(readJobSignals(pending.signalsFile).signals).toHaveLength(1);
    expect(readDeliveries(pending.notificationOutboxFile)).toHaveLength(1);
  });
});
