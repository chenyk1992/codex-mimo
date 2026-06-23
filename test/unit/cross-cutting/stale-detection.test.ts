import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createJobStore,
  failStaleJobs,
  readJob,
  updateJob
} from "../../../src/core/job-store.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-xcut-stale-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("job stale detection", () => {
  it("queued jobs older than threshold are auto-failed", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", workflow: "dev", task: "Stale task", request: {} });

    const failed = failStaleJobs(cwd, { staleThresholdMs: 0 });

    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe(job.id);
    expect(failed[0].status).toBe("failed");
    expect(failed[0].errorCode).toBe("stale_queued");
    expect(failed[0].error).toContain("stuck in queued state");

    const stored = readJob(cwd, job.id);
    expect(stored?.status).toBe("failed");
  });

  it("running jobs are not affected by stale detection", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", workflow: "dev", task: "Running task", request: {} });
    updateJob(cwd, job.id, { status: "running", phase: "editing", pid: 42 });

    const failed = failStaleJobs(cwd, { staleThresholdMs: 0 });

    expect(failed).toHaveLength(0);
    const stored = readJob(cwd, job.id);
    expect(stored?.status).toBe("running");
  });

  it("completed jobs are not affected by stale detection", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", workflow: "dev", task: "Done task", request: {} });
    updateJob(cwd, job.id, { status: "completed", phase: "done" });

    const failed = failStaleJobs(cwd, { staleThresholdMs: 0 });

    expect(failed).toHaveLength(0);
    const stored = readJob(cwd, job.id);
    expect(stored?.status).toBe("completed");
  });

  it("recent queued jobs are not marked stale", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    store.create({ kind: "compose", workflow: "dev", task: "Fresh", request: {} });

    const failed = failStaleJobs(cwd, { staleThresholdMs: 300_000 });

    expect(failed).toHaveLength(0);
  });
});
