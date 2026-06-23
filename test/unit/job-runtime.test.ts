import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendRuntimeEvent, completeRuntimeJob, failRuntimeJob, startRuntimeJob } from "../../src/core/job-runtime.js";
import { createJobStore, readJob } from "../../src/core/job-store.js";

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-job-runtime-"));
}

describe("job runtime lifecycle", () => {
  it("marks a job running and appends normalized progress", () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      task: "Run dev",
      request: { workflow: "dev" }
    });

    startRuntimeJob(cwd, job.id, { pid: 321 });
    appendRuntimeEvent(cwd, job.id, "{\"type\":\"message\",\"text\":\"Inspecting files\"}");

    const updated = readJob(cwd, job.id);
    expect(updated?.status).toBe("running");
    expect(updated?.phase).toBe("investigating");
    expect(updated?.summary).toBe("Inspecting files");
    expect(fs.readFileSync(updated!.eventsFile, "utf-8")).toContain("Inspecting files");
  });

  it("completes and fails jobs with final metadata", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const complete = store.create({ kind: "compose", task: "complete", request: {} });
    completeRuntimeJob(cwd, complete.id, {
      summary: "done",
      sessionId: "sess_1",
      changedFiles: ["src/a.ts"],
      verification: [],
      reportPaths: { json: "report.json" }
    });

    expect(readJob(cwd, complete.id)).toMatchObject({
      status: "completed",
      phase: "done",
      summary: "done",
      sessionId: "sess_1"
    });

    const failed = store.create({ kind: "compose", task: "fail", request: {} });
    failRuntimeJob(cwd, failed.id, {
      errorCode: "nonzero_exit",
      error: "MiMo failed"
    });

    expect(readJob(cwd, failed.id)).toMatchObject({
      status: "failed",
      phase: "failed",
      errorCode: "nonzero_exit"
    });
  });
});
