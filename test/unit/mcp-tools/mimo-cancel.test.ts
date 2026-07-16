import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobStore, updateJob, readJob } from "../../../src/core/job-store.js";
import { mimoCancel } from "../../../src/codex/tools.js";
import { readJobSignals } from "../../../src/core/job-signals.js";

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
    updateJob(cwd, job.id, {
      status: "running", phase: "investigating", pid: 456, processIdentity: "start-456"
    });
    const killProcess = vi.fn();
    const result = await mimoCancel({ cwd, jobId: job.id }, { killProcess });
    expect(result.status).toBe("cancelled");
    expect(result.summary).toContain("Cancelled");
    expect(killProcess).toHaveBeenCalledWith(456);
    const updated = readJob(cwd, job.id);
    expect(updated!.status).toBe("cancelled");
    expect(readJobSignals(updated!.signalsFile).signals.at(-1)).toMatchObject({
      kind: "cancelled",
      status: "cancelled",
      phase: "cancelled",
      summary: `Cancelled ${job.id}.`
    });
  });

  it("throws when jobId does not exist", async () => {
    const cwd = tempWorkspace();
    await expect(mimoCancel({ cwd, jobId: "nonexistent-id" })).rejects.toThrow("No job found");
  });
});
