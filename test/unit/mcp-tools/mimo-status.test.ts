import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJobStore, updateJob } from "../../../src/core/job-store.js";
import { mimoStatus } from "../../../src/codex/tools.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-status-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("mimo_status", () => {
  it("returns status for a specific jobId", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
    updateJob(cwd, job.id, { status: "running", phase: "investigating", pid: 100 });
    const result = await mimoStatus({ cwd, jobId: job.id });
    expect(result.jobId).toBe(job.id);
    expect(result.status).toBe("running");
    expect(result.phase).toBe("investigating");
  });

  it("defaults to most recent job when jobId is omitted", async () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job1 = store.create({ kind: "compose", task: "First", request: {} });
    const job2 = store.create({ kind: "compose", task: "Second", request: {} });
    updateJob(cwd, job2.id, { status: "completed", phase: "done", summary: "Done" });
    const result = await mimoStatus({ cwd });
    expect(result.jobId).toBe(job2.id);
  });

  it("throws when no jobs exist", async () => {
    const cwd = tempWorkspace();
    await expect(mimoStatus({ cwd })).rejects.toThrow("No jobs recorded");
  });
});
