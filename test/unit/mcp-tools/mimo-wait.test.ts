import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mimoWait } from "../../../src/codex/tools.js";
import { createJobStore, updateJob } from "../../../src/core/job-store.js";
import { appendJobSignal } from "../../../src/core/job-signals.js";

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
    const result = await mimoWait({ cwd, jobId: job.id, timeoutMs: 10_000 }, {
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

    expect(result).toMatchObject({ status: "running", phase: "reviewing", timedOut: true, waitedMs: 2_500 });
    expect(result.signals).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/heartbeat|wake/i);
  });
});
