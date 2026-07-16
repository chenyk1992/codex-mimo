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
      summary: "Reading files."
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
      summary: "Reading files."
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
    expect(result.signals[0]).toMatchObject({ level: "error", summary: "Failed." });
  });

  it("throws for missing jobs", async () => {
    const cwd = tempWorkspace();
    await expect(mimoEvents({ cwd, jobId: "compose-missing" })).rejects.toThrow("No job found");
  });
});
