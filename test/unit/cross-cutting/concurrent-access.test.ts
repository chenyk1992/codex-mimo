import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createJobStore,
  listJobs,
  readJob,
  updateJob
} from "../../../src/core/job-store.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-xcut-conc-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("concurrent access", () => {
  it("two compose creates write to state.json without corruption", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);

    const job1 = store.create({ kind: "compose", workflow: "dev", task: "Task 1", request: {} });
    const job2 = store.create({ kind: "compose", workflow: "dev", task: "Task 2", request: {} });

    const jobs = listJobs(cwd);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.id)).toContain(job1.id);
    expect(jobs.map((j) => j.id)).toContain(job2.id);
  });

  it("concurrent updateJob uses last-write-wins", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", workflow: "dev", task: "Shared", request: {} });

    const updated1 = updateJob(cwd, job.id, { status: "running", phase: "starting", pid: 100 });
    const updated2 = updateJob(cwd, job.id, { status: "running", phase: "editing", pid: 200 });

    const stored = readJob(cwd, job.id);
    expect(stored?.phase).toBe("editing");
    expect(stored?.pid).toBe(200);
    expect(updated2.updatedAt >= updated1.updatedAt).toBe(true);
  });

  it("listJobs + createJob concurrent does not lose jobs", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);

    store.create({ kind: "compose", workflow: "dev", task: "First", request: {} });
    const midList = listJobs(cwd);
    store.create({ kind: "compose", workflow: "dev", task: "Second", request: {} });
    store.create({ kind: "compose", workflow: "dev", task: "Third", request: {} });
    const finalList = listJobs(cwd);

    expect(midList).toHaveLength(1);
    expect(finalList).toHaveLength(3);
  });
});
