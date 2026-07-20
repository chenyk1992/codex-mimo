import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mimoEvents } from "../../../src/codex/tools.js";
import { createJobStore, updateJob } from "../../../src/core/job-store.js";
import { appendJobSignal } from "../../../src/core/job-signals.js";

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-events-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("mimo_events", () => {
  it("returns incremental signals for a specific job", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
    updateJob(cwd, job.id, {
      status: "running", phase: "investigating", pid: 100, processIdentity: "start-100"
    });
    appendJobSignal(job.signalsFile, {
      jobId: job.id,
      kind: "phase_changed",
      level: "info",
      phase: "starting",
      summary: "Starting."
    });
    appendJobSignal(job.signalsFile, {
      jobId: job.id,
      kind: "milestone",
      level: "info",
      phase: "investigating",
      summary: "MiMoCode reported progress."
    });

    const result = await mimoEvents({ cwd, jobId: job.id, sinceCursor: 1, minLevel: "info" });
    expect(result.jobId).toBe(job.id);
    expect(result.status).toBe("running");
    expect(result.phase).toBe("investigating");
    expect(result.nextCursor).toBe(2);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({
      cursor: 2,
      kind: "milestone",
      summary: "MiMoCode reported progress."
    });
    expect(result.actions).toEqual({ status: "mimo_status", cancel: "mimo_cancel" });
  });

  it("defaults to the most recent job and filters by level", async () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    store.create({ kind: "compose", task: "First", request: {} });
    const job = store.create({ kind: "compose", task: "Second", request: {} });
    appendJobSignal(job.signalsFile, {
      jobId: job.id,
      kind: "milestone",
      level: "debug",
      summary: "Debug only."
    });
    appendJobSignal(job.signalsFile, {
      jobId: job.id,
      kind: "failed",
      level: "error",
      summary: "Failed."
    });

    const result = await mimoEvents({ cwd, minLevel: "info" });
    expect(result.jobId).toBe(job.id);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({ level: "error", summary: "MiMoCode job failed." });
  });

  it("defaults minLevel to warn", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "plan", task: "Plan", request: {} });
    appendJobSignal(job.signalsFile, {
      jobId: job.id, kind: "milestone", level: "info", summary: "info only"
    });
    appendJobSignal(job.signalsFile, {
      jobId: job.id, kind: "failed", level: "error", status: "failed", summary: "boom"
    });
    const result = await mimoEvents({ cwd, jobId: job.id });
    expect(result.signals.map((s) => s.level)).toEqual(["error"]);
  });

  it("throws for missing jobs", async () => {
    const cwd = tempWorkspace();
    await expect(mimoEvents({ cwd, jobId: "compose-missing" })).rejects.toThrow("No job found");
  });

  it("paginates without advancing past signals omitted by limit", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "plan", task: "Plan", request: {} });
    for (const summary of ["one", "two", "three"]) {
      appendJobSignal(job.signalsFile, {
        jobId: job.id, kind: "milestone", level: "info", summary
      });
    }

    const first = await mimoEvents({ cwd, jobId: job.id, sinceCursor: 0, limit: 2, minLevel: "debug" });
    expect(first.signals.map((signal) => signal.cursor)).toEqual([1, 2]);
    expect(first.nextCursor).toBe(2);

    const second = await mimoEvents({ cwd, jobId: job.id, sinceCursor: first.nextCursor, limit: 2, minLevel: "debug" });
    expect(second.signals.map((signal) => signal.cursor)).toEqual([3]);
    expect(second.nextCursor).toBe(3);
  });

  it("may advance across filtered signals but not a later unreturned match", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "review", task: "Review", request: {} });
    appendJobSignal(job.signalsFile, { jobId: job.id, kind: "milestone", level: "debug", summary: "ignored" });
    appendJobSignal(job.signalsFile, { jobId: job.id, kind: "milestone", level: "info", summary: "returned" });
    appendJobSignal(job.signalsFile, { jobId: job.id, kind: "milestone", level: "info", summary: "later" });

    const first = await mimoEvents({ cwd, jobId: job.id, minLevel: "info", limit: 1 });
    expect(first.signals.map((signal) => signal.cursor)).toEqual([2]);
    expect(first.nextCursor).toBe(2);
    expect((await mimoEvents({ cwd, jobId: job.id, sinceCursor: 2, minLevel: "info", limit: 1 })).signals[0]?.cursor)
      .toBe(3);
  });
});
