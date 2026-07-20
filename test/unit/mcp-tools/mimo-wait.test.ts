import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mimoWait } from "../../../src/codex/tools.js";
import { createJobStore, updateJob } from "../../../src/core/job-store.js";
import {
  appendJobSignal,
  isAttentionSignal,
  readJobSignalPage
} from "../../../src/core/job-signals.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-wait-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const cwd of tempDirs.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

describe("mimo_wait", () => {
  it("ignores ordinary progress and returns only attention signals", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
    updateJob(cwd, job.id, {
      status: "running", phase: "investigating", pid: 100, processIdentity: "start-100"
    });
    appendJobSignal(job.signalsFile, {
      jobId: job.id, kind: "milestone", level: "info", summary: "Ordinary progress."
    });

    let now = 0;
    const delays: number[] = [];
    const result = await mimoWait({ cwd, jobId: job.id, timeoutMs: 10_000, minLevel: "debug" }, {
      now: () => now,
      intervalMs: 1_000,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
        appendJobSignal(job.signalsFile, {
          jobId: job.id,
          kind: "completed",
          level: "info",
          status: "completed",
          summary: "Done."
        });
      }
    });

    expect(delays).toEqual([1_000]);
    expect(result.signals.map((signal) => signal.kind)).toEqual(["completed"]);
    expect(result.nextCursor).toBe(2);
    expect(result.timedOut).toBe(false);
  });

  it("continues internal scans after the last confirmed ordinary signal", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
    appendJobSignal(job.signalsFile, {
      jobId: job.id, kind: "milestone", level: "info", summary: "Ordinary progress."
    });
    const scanCursors: number[] = [];
    const readSignals = vi.fn((selected, options) => {
      scanCursors.push(options.sinceCursor);
      return readJobSignalPage(selected.signalsFile, { ...options, include: isAttentionSignal });
    });
    let now = 0;

    const result = await mimoWait({ cwd, jobId: job.id, timeoutMs: 10_000, minLevel: "debug" }, {
      now: () => now,
      intervalMs: 1_000,
      readSignals,
      sleep: async (milliseconds) => {
        now += milliseconds;
        appendJobSignal(job.signalsFile, {
          jobId: job.id, kind: "completed", level: "info", summary: "Done."
        });
      }
    });

    expect(scanCursors).toEqual([0, 1]);
    expect(result.signals.map((signal) => signal.cursor)).toEqual([2]);
    expect(result.nextCursor).toBe(2);
    expect(result.timedOut).toBe(false);
  });

  it("does not expose pollMs in the public schema", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "plan", task: "Plan", request: {} });
    await expect(mimoWait({ cwd, jobId: job.id, timeoutMs: 1, pollMs: 1 }))
      .rejects.toThrow();
  });

  it("returns empty signals and current status on timeout without a heartbeat", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "review", task: "Review", request: {} });
    updateJob(cwd, job.id, {
      status: "running", phase: "reviewing", pid: 101, processIdentity: "start-101"
    });
    appendJobSignal(job.signalsFile, {
      jobId: job.id, kind: "phase_changed", level: "info", summary: "Reviewing."
    });
    let now = 0;

    const result = await mimoWait({ cwd, jobId: job.id, timeoutMs: 2_500 }, {
      now: () => now,
      intervalMs: 1_000,
      sleep: async (milliseconds) => { now += milliseconds; }
    });

    expect(result).toMatchObject({
      status: "running",
      phase: "reviewing",
      timedOut: true,
      waitedMs: 2_500,
      signals: [],
      diagnosis: expect.any(String),
      nextAction: "status_once"
    });
    expect(result.diagnosis.length).toBeGreaterThan(0);
    expect(result.diagnosis.length).toBeLessThanOrEqual(160);
    expect(result.nextCursor).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/heartbeat|wake/i);
  });

  it("defaults minLevel to info so completed attention signals are visible", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "plan", task: "Plan", request: {} });
    appendJobSignal(job.signalsFile, {
      jobId: job.id,
      kind: "completed",
      level: "info",
      status: "completed",
      summary: "Done."
    });

    const result = await mimoWait({ cwd, jobId: job.id, timeoutMs: 10 });

    expect(result.timedOut).toBe(false);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({ kind: "completed", level: "info" });
  });

  it("paginates attention signals without advancing past an omitted attention", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run", request: {} });
    for (const [kind, summary] of [
      ["needs_input", "one"], ["blocked", "two"], ["completed", "three"]
    ] as const) {
      appendJobSignal(job.signalsFile, { jobId: job.id, kind, level: "warn", summary });
    }

    const first = await mimoWait({ cwd, jobId: job.id, sinceCursor: 0, limit: 2, timeoutMs: 10 });
    expect(first.signals.map((signal) => signal.cursor)).toEqual([1, 2]);
    expect(first.nextCursor).toBe(2);

    const second = await mimoWait({ cwd, jobId: job.id, sinceCursor: first.nextCursor, limit: 2, timeoutMs: 10 });
    expect(second.signals.map((signal) => signal.cursor)).toEqual([3]);
    expect(second.nextCursor).toBe(3);
  });

  it("advances across ordinary signals before an attention page", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "plan", task: "Plan", request: {} });
    appendJobSignal(job.signalsFile, { jobId: job.id, kind: "milestone", level: "info", summary: "ordinary" });
    appendJobSignal(job.signalsFile, { jobId: job.id, kind: "completed", level: "info", summary: "first" });
    appendJobSignal(job.signalsFile, { jobId: job.id, kind: "failed", level: "error", summary: "second" });

    const first = await mimoWait({ cwd, jobId: job.id, limit: 1, timeoutMs: 10, minLevel: "debug" });
    expect(first.signals.map((signal) => signal.cursor)).toEqual([2]);
    expect(first.nextCursor).toBe(2);
    expect((await mimoWait({ cwd, jobId: job.id, sinceCursor: 2, limit: 1, timeoutMs: 10, minLevel: "debug" })).signals[0]?.cursor)
      .toBe(3);
  });
});
