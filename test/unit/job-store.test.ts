import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createJobStore,
  listJobs,
  readJob,
  resolveJobPaths,
  updateJob
} from "../../src/core/job-store.js";

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-job-store-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const cwd of tempDirs.splice(0)) {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

describe("job store", () => {
  it("creates a job with per-job paths and newest-first state", () => {
    const cwd = tempWorkspace();
    const task = "Run dev workflow";
    const request = { workflow: "dev", task };

    const job = createJobStore(cwd).create({ kind: "compose", workflow: "dev", task, request });
    const paths = resolveJobPaths(cwd, job.id);

    expect(job.id.startsWith("compose-")).toBe(true);
    expect(fs.existsSync(paths.jobFile)).toBe(true);
    expect(readJob(cwd, job.id)?.task).toBe(task);
    expect(listJobs(cwd).map((entry) => entry.id)).toEqual([job.id]);
  });

  it("updates a job without losing immutable fields", () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      workflow: "dev",
      task: "Run dev workflow",
      request: { workflow: "dev" }
    });

    const updated = updateJob(cwd, job.id, { status: "running", phase: "starting", pid: 123 });

    expect(updated.id).toBe(job.id);
    expect(updated.kind).toBe(job.kind);
    expect(updated.cwd).toBe(job.cwd);
    expect(updated.createdAt).toBe(job.createdAt);
    expect(updated.status).toBe("running");
    expect(updated.phase).toBe("starting");
    expect(updated.pid).toBe(123);
    expect(updated.updatedAt >= job.updatedAt).toBe(true);
  });

  it("prunes state entries while keeping newest jobs", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd, { maxJobs: 2 });

    const first = store.create({ kind: "compose", workflow: "dev", task: "First", request: {} });
    const second = store.create({ kind: "compose", workflow: "dev", task: "Second", request: {} });
    const third = store.create({ kind: "compose", workflow: "dev", task: "Third", request: {} });

    expect(listJobs(cwd).map((entry) => entry.id)).toEqual([third.id, second.id]);
    expect(fs.existsSync(resolveJobPaths(cwd, first.id).jobFile)).toBe(false);
  });
});
