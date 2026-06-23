import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createJobStore,
  listJobs,
  readJob,
  resolveJobPaths,
  resolveJobStateFile,
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
  it("rejects unsafe job ids before resolving paths", () => {
    const cwd = tempWorkspace();

    expect(() => resolveJobPaths(cwd, "../outside")).toThrow(/invalid job id/i);
    expect(() => resolveJobPaths(cwd, "")).toThrow(/invalid job id/i);
    expect(() => resolveJobPaths(cwd, "state")).toThrow(/invalid job id/i);
    expect(() => resolveJobPaths(cwd, "a\\b")).toThrow(/invalid job id/i);
    expect(() => readJob(cwd, "a/b")).toThrow(/invalid job id/i);
  });

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

  it("recovers state from job files when state json is corrupt", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);

    const first = store.create({ kind: "compose", workflow: "dev", task: "First", request: {} });
    fs.writeFileSync(resolveJobPaths(cwd, "compose-bad-file").jobFile, "{bad-job", "utf-8");
    fs.writeFileSync(resolveJobPaths(cwd, "compose-empty").jobFile, "{}", "utf-8");
    fs.writeFileSync(
      resolveJobPaths(cwd, "compose-mismatch").jobFile,
      JSON.stringify({ ...first, id: "compose-different" }),
      "utf-8"
    );
    fs.writeFileSync(resolveJobStateFile(cwd), "{not-json", "utf-8");

    const second = store.create({ kind: "compose", workflow: "dev", task: "Second", request: {} });

    expect(listJobs(cwd).map((entry) => entry.id)).toEqual([second.id, first.id]);
  });

  it("throws when reading an existing malformed job file directly", () => {
    const cwd = tempWorkspace();
    const paths = resolveJobPaths(cwd, "compose-bad-file");
    fs.mkdirSync(path.dirname(paths.jobFile), { recursive: true });
    fs.writeFileSync(paths.jobFile, "{bad-job", "utf-8");

    expect(() => readJob(cwd, "compose-bad-file")).toThrow(/malformed job/i);

    fs.writeFileSync(paths.jobFile, "{}", "utf-8");

    expect(() => readJob(cwd, "compose-bad-file")).toThrow(/malformed job/i);
  });

  it("does not prune active jobs", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd, { maxJobs: 2 });

    const active = store.create({ kind: "compose", workflow: "dev", task: "Active", request: {} });
    const completed = store.create({ kind: "compose", workflow: "dev", task: "Completed", request: {} });
    updateJob(cwd, completed.id, { status: "completed", phase: "done" }, { maxJobs: 2 });
    const newest = store.create({ kind: "compose", workflow: "dev", task: "Newest", request: {} });
    updateJob(cwd, newest.id, { status: "completed", phase: "done" }, { maxJobs: 2 });

    expect(readJob(cwd, active.id)?.status).toBe("queued");
    expect(listJobs(cwd).map((entry) => entry.id)).toEqual([newest.id, active.id]);
  });

  it("uses update maxJobs option when pruning after updates", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd, { maxJobs: 3 });

    const first = store.create({ kind: "compose", workflow: "dev", task: "First", request: {} });
    const second = store.create({ kind: "compose", workflow: "dev", task: "Second", request: {} });
    const third = store.create({ kind: "compose", workflow: "dev", task: "Third", request: {} });

    updateJob(cwd, second.id, { status: "completed", phase: "done" }, { maxJobs: 3 });
    updateJob(cwd, third.id, { status: "completed", phase: "done" }, { maxJobs: 3 });
    updateJob(cwd, first.id, { status: "completed", phase: "done" }, { maxJobs: 2 });

    expect(listJobs(cwd).map((entry) => entry.id)).toEqual([first.id, third.id]);
    expect(readJob(cwd, second.id)).toBeUndefined();
  });

  it("does not delete malformed job artifacts while pruning state", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);

    const job = store.create({ kind: "compose", workflow: "dev", task: "Valid", request: {} });
    const partialPaths = resolveJobPaths(cwd, "compose-partial");
    fs.writeFileSync(partialPaths.jobFile, "{partial-job", "utf-8");
    fs.writeFileSync(partialPaths.logFile, "partial log", "utf-8");
    fs.writeFileSync(partialPaths.eventsFile, "{}\n", "utf-8");
    fs.writeFileSync(resolveJobStateFile(cwd), JSON.stringify({ jobs: ["compose-partial", job.id] }), "utf-8");

    updateJob(cwd, job.id, { status: "completed", phase: "done" }, { maxJobs: 10 });

    expect(fs.existsSync(partialPaths.jobFile)).toBe(true);
    expect(fs.existsSync(partialPaths.logFile)).toBe(true);
    expect(fs.existsSync(partialPaths.eventsFile)).toBe(true);
    expect(listJobs(cwd).map((entry) => entry.id)).toEqual([job.id]);
  });

  it("prunes state entries while keeping newest jobs", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd, { maxJobs: 2 });

    const first = store.create({ kind: "compose", workflow: "dev", task: "First", request: {} });
    const second = store.create({ kind: "compose", workflow: "dev", task: "Second", request: {} });
    const firstPaths = resolveJobPaths(cwd, first.id);
    fs.writeFileSync(firstPaths.logFile, "first log", "utf-8");
    fs.writeFileSync(firstPaths.eventsFile, "{}\n", "utf-8");
    updateJob(cwd, first.id, { status: "completed", phase: "done" }, { maxJobs: 2 });
    updateJob(cwd, second.id, { status: "completed", phase: "done" }, { maxJobs: 2 });
    const third = store.create({ kind: "compose", workflow: "dev", task: "Third", request: {} });

    expect(listJobs(cwd).map((entry) => entry.id)).toEqual([third.id, second.id]);
    expect(fs.existsSync(firstPaths.jobFile)).toBe(false);
    expect(fs.existsSync(firstPaths.logFile)).toBe(false);
    expect(fs.existsSync(firstPaths.eventsFile)).toBe(false);
  });
});
