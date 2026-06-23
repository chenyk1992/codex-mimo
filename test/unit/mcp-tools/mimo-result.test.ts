import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJobStore, updateJob } from "../../../src/core/job-store.js";
import { SessionStore } from "../../../src/core/sessions.js";
import { mimoResult } from "../../../src/codex/tools.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-result-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("mimo_result", () => {
  it("saves to SessionStore when sessionId is present", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", workflow: "dev", task: "Run dev", request: {} });
    updateJob(cwd, job.id, {
      status: "completed",
      phase: "done",
      summary: "Passed.",
      sessionId: "ses_store1",
      reportPaths: { json: "report.json" }
    });
    await mimoResult({ cwd, jobId: job.id });
    const store = new SessionStore(cwd);
    const entry = store.get("ses_store1");
    expect(entry).toBeDefined();
    expect(entry!.jobId).toBe(job.id);
    expect(entry!.status).toBe("completed");
  });

  it("defaults to most recent finished job when jobId is omitted", async () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job1 = store.create({ kind: "compose", task: "First", request: {} });
    const job2 = store.create({ kind: "compose", task: "Second", request: {} });
    updateJob(cwd, job1.id, { status: "completed", phase: "done", summary: "First done" });
    updateJob(cwd, job2.id, { status: "completed", phase: "done", summary: "Second done" });
    const result = await mimoResult({ cwd });
    expect(result.jobId).toBe(job2.id);
    expect(result.summary).toBe("Second done");
  });

  it("throws when no finished jobs exist", async () => {
    const cwd = tempWorkspace();
    await expect(mimoResult({ cwd })).rejects.toThrow("No finished jobs");
  });
});
