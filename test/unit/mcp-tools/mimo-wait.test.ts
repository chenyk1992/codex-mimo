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
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("mimo_wait", () => {
  it("returns immediately when signals are already available", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
    updateJob(cwd, job.id, { status: "running", phase: "investigating", pid: 100 });
    appendJobSignal(job.signalsFile, {
      jobId: job.id,
      kind: "milestone",
      level: "info",
      phase: "investigating",
      summary: "Found test files."
    });

    const result = await mimoWait({ cwd, jobId: job.id, timeoutMs: 100, pollMs: 5 });

    expect(result.timedOut).toBe(false);
    expect(result.nextCursor).toBe(1);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({ summary: "Found test files." });
  });

  it("waits until a new signal arrives", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
    updateJob(cwd, job.id, { status: "running", phase: "starting", pid: 100 });

    setTimeout(() => {
      appendJobSignal(job.signalsFile, {
        jobId: job.id,
        kind: "phase_changed",
        level: "info",
        phase: "verifying",
        summary: "Verification started."
      });
    }, 20);

    const result = await mimoWait({ cwd, jobId: job.id, sinceCursor: 0, timeoutMs: 500, pollMs: 5 });

    expect(result.timedOut).toBe(false);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({ kind: "phase_changed", phase: "verifying" });
  });

  it("returns a timeout marker without loading verbose status output", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
    updateJob(cwd, job.id, { status: "running", phase: "editing", pid: 100 });

    const result = await mimoWait({ cwd, jobId: job.id, timeoutMs: 25, pollMs: 5 });

    expect(result.timedOut).toBe(true);
    expect(result.status).toBe("running");
    expect(result.phase).toBe("editing");
    expect(result.signals).toEqual([]);
  });
});
