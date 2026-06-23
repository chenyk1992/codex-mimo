import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJobStore, updateJob } from "../../../src/core/job-store.js";
import { mimoJobs } from "../../../src/codex/tools.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-jobs-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("mimo_jobs", () => {
  it("lists recent jobs (default limit)", async () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    for (let i = 0; i < 10; i++) {
      const job = store.create({ kind: "compose", task: `Task ${i}`, request: {} });
      updateJob(cwd, job.id, { status: "completed", phase: "done", summary: `Done ${i}` });
    }
    const result = await mimoJobs({ cwd });
    expect(result.length).toBeLessThanOrEqual(8);
    expect(result.length).toBeGreaterThan(0);
  });

  it("lists all jobs when all=true", async () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    for (let i = 0; i < 10; i++) {
      const job = store.create({ kind: "compose", task: `Task ${i}`, request: {} });
      updateJob(cwd, job.id, { status: "completed", phase: "done", summary: `Done ${i}` });
    }
    const result = await mimoJobs({ cwd, all: true });
    expect(result).toHaveLength(10);
  });
});
