import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobStore, updateJob, readJob } from "../../../src/core/job-store.js";
import { mimoCancel } from "../../../src/codex/tools.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-cancel-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("mimo_cancel", () => {
  it("cancels an active job and calls killProcess", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
    updateJob(cwd, job.id, { status: "running", phase: "investigating", pid: 456 });
    const killProcess = vi.fn();
    const result = await mimoCancel({ cwd, jobId: job.id }, { killProcess });
    expect(result.status).toBe("cancelled");
    expect(result.summary).toContain("Cancelled");
    expect(killProcess).toHaveBeenCalledWith(456);
    const updated = readJob(cwd, job.id);
    expect(updated!.status).toBe("cancelled");
  });

  it("throws when jobId does not exist", async () => {
    const cwd = tempWorkspace();
    await expect(mimoCancel({ cwd, jobId: "nonexistent-id" })).rejects.toThrow("No job found");
  });
});
