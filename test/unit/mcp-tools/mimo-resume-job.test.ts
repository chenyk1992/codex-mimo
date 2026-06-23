import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobStore, updateJob } from "../../../src/core/job-store.js";
import { mimoResumeJob } from "../../../src/codex/tools.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-resume-job-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("mimo_resume_job", () => {
  it("creates a child job with parent sessionId", async () => {
    const cwd = tempWorkspace();
    const parent = createJobStore(cwd).create({ kind: "compose", workflow: "dev", task: "Run dev", request: {} });
    updateJob(cwd, parent.id, { status: "completed", phase: "done", sessionId: "ses_parent1" });
    const result = await mimoResumeJob({ cwd, jobId: parent.id, task: "Continue work" });
    expect(result.jobId).toBeDefined();
    expect(result.jobId).not.toBe(parent.id);
    expect(result.parentJobId).toBe(parent.id);
    expect(result.sessionId).toBe("ses_parent1");
    expect(result.status).toBe("queued");
  });

  it("throws when parent has no sessionId", async () => {
    const cwd = tempWorkspace();
    const parent = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
    await expect(
      mimoResumeJob({ cwd, jobId: parent.id, task: "Continue" })
    ).rejects.toThrow("does not have a sessionId");
  });

  it("spawns background worker when background=true", async () => {
    const cwd = tempWorkspace();
    const parent = createJobStore(cwd).create({ kind: "compose", workflow: "dev", task: "Run dev", request: {} });
    updateJob(cwd, parent.id, { status: "completed", phase: "done", sessionId: "ses_bg1" });
    const spawnJobWorker = vi.fn().mockReturnValue(789);
    const result = await mimoResumeJob(
      { cwd, jobId: parent.id, task: "Continue in bg", background: true },
      { spawnJobWorker }
    );
    expect(result.status).toBe("queued");
    expect(spawnJobWorker).toHaveBeenCalledWith(
      cwd,
      "compose",
      expect.any(String),
      expect.objectContaining({ onExit: expect.any(Function) })
    );
  });
});
