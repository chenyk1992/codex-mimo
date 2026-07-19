import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJobStore, listJobs, readJob, updateJob, resolveJobPaths, resolveJobStateFile } from "../../../src/core/job-store.js";

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-job-lifecycle-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("job lifecycle", () => {
  it("5.16: create writes the authoritative job record and listJobs rebuilds its cache", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", task: "Test task", request: {} });

    const paths = resolveJobPaths(cwd, job.id);
    expect(fs.existsSync(paths.jobFile)).toBe(true);
    expect(fs.existsSync(paths.logFile)).toBe(false);
    expect(fs.existsSync(paths.eventsFile)).toBe(false);
    expect(listJobs(cwd).map((entry) => entry.id)).toContain(job.id);
  });

  it("5.17: listJobs reads queued jobs without changing lifecycle state", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", task: "Old task", request: {} });

    const jobs = listJobs(cwd);
    expect(jobs).toHaveLength(1);
    expect(readJob(cwd, job.id)?.status).toBe("queued");
  });

  it("5.18: readJob non-existent → undefined", () => {
    const cwd = tempWorkspace();
    expect(readJob(cwd, "non-existent-id")).toBeUndefined();
  });

  it("5.19: updateJob preserves immutable fields", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", task: "Test", request: {} });

    const updated = updateJob(cwd, job.id, { status: "running", phase: "starting" });

    expect(updated.id).toBe(job.id);
    expect(updated.kind).toBe(job.kind);
    expect(updated.cwd).toBe(job.cwd);
    expect(updated.createdAt).toBe(job.createdAt);
    expect(updated.status).toBe("running");
    expect(updated.phase).toBe("starting");
  });

  it("5.20: state.json corruption → rebuildState", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    store.create({ kind: "compose", task: "Task 1", request: {} });

    const stateFile = resolveJobStateFile(cwd);
    fs.writeFileSync(stateFile, "invalid-json", "utf-8");

    const jobs = listJobs(cwd);
    expect(jobs).toHaveLength(1);
  });

});
