import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJobStore, listJobs, readJob, updateJob, failStaleJobs, resolveJobPaths, resolveJobStateFile } from "../../../src/core/job-store.js";
import { startRuntimeJob, appendRuntimeEvent, completeRuntimeJob, failRuntimeJob } from "../../../src/core/job-runtime.js";

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
  it("5.16: create writes .json + .log + .events.jsonl + state.json", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", task: "Test task", request: {} });

    const paths = resolveJobPaths(cwd, job.id);
    expect(fs.existsSync(paths.jobFile)).toBe(true);
    expect(fs.existsSync(paths.logFile)).toBe(false);
    expect(fs.existsSync(paths.eventsFile)).toBe(false);
    expect(fs.existsSync(resolveJobStateFile(cwd))).toBe(true);
  });

  it("5.17: listJobs calls failStaleJobs first", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    store.create({ kind: "compose", task: "Old task", request: {} });

    const jobs = listJobs(cwd);
    expect(jobs).toHaveLength(1);
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

  it("5.24: startRuntimeJob → status running, phase starting", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", task: "Test", request: {} });

    const started = startRuntimeJob(cwd, job.id, { pid: 123 });

    expect(started.status).toBe("running");
    expect(started.phase).toBe("starting");
    expect(started.pid).toBe(123);
  });

  it("5.25: appendRuntimeEvent → parses event, infers phase, writes log", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", task: "Test", request: {} });
    startRuntimeJob(cwd, job.id);

    const event = JSON.stringify({ type: "message", text: "Looking at code" });
    const updated = appendRuntimeEvent(cwd, job.id, event);

    expect(updated.phase).toBe("investigating");
    expect(updated.summary).toBe("Looking at code");
  });

  it("5.26: completeRuntimeJob → status completed, phase done", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", task: "Test", request: {} });
    startRuntimeJob(cwd, job.id);

    const completed = completeRuntimeJob(cwd, job.id, {
      summary: "Done",
      sessionId: "sess_1",
      changedFiles: ["src/a.ts"],
      verification: []
    });

    expect(completed.status).toBe("completed");
    expect(completed.phase).toBe("done");
    expect(completed.sessionId).toBe("sess_1");
    expect(completed.changedFiles).toEqual(["src/a.ts"]);
  });

  it("5.27: failRuntimeJob → status failed, phase failed", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", task: "Test", request: {} });
    startRuntimeJob(cwd, job.id);

    const failed = failRuntimeJob(cwd, job.id, {
      errorCode: "nonzero_exit",
      error: "Process exited with code 1"
    });

    expect(failed.status).toBe("failed");
    expect(failed.phase).toBe("failed");
    expect(failed.errorCode).toBe("nonzero_exit");
    expect(failed.error).toBe("Process exited with code 1");
  });

  it("5.28: appendRuntimeEvent on non-active → silent skip", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", task: "Test", request: {} });
    completeRuntimeJob(cwd, job.id, {
      summary: "Done",
      changedFiles: [],
      verification: []
    });

    const event = JSON.stringify({ type: "message", text: "Should not append" });
    const result = appendRuntimeEvent(cwd, job.id, event);

    expect(result.status).toBe("completed");
  });
});
