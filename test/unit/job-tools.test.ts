import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createJobStore, updateJob } from "../../src/core/job-store.js";
import { mimoCancel, mimoJobs, mimoResult, mimoResumeJob, mimoStatus } from "../../src/codex/tools.js";

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-job-tools-"));
}

describe("job MCP tools", () => {
  it("returns status and result for jobs", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
    updateJob(cwd, job.id, {
      status: "completed",
      phase: "done",
      summary: "dev passed",
      sessionId: "sess_1",
      changedFiles: ["src/a.ts"],
      reportPaths: { json: "report.json" }
    });

    expect(await mimoStatus({ cwd, jobId: job.id })).toMatchObject({
      jobId: job.id,
      status: "completed"
    });
    expect(await mimoResult({ cwd, jobId: job.id })).toMatchObject({
      jobId: job.id,
      summary: "dev passed",
      resumeHint: { tool: "mimo_resume_job", jobId: job.id }
    });
    expect(await mimoJobs({ cwd })).toHaveLength(1);
  });

  it("cancels an active job", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
    updateJob(cwd, job.id, { status: "running", phase: "investigating", pid: 123 });
    const killProcess = vi.fn();

    const result = await mimoCancel({ cwd, jobId: job.id }, { killProcess });

    expect(result.status).toBe("cancelled");
    expect(killProcess).toHaveBeenCalledWith(123);
  });

  it("rejects resume by job when the parent has no session id", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });

    await expect(mimoResumeJob({ cwd, jobId: job.id, task: "continue" })).rejects.toThrow("does not have a sessionId");
  });
});
