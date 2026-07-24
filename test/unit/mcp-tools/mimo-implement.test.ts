import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mimoImplement } from "../../../src/codex/tools.js";
import { readJob } from "../../../src/core/job-store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("mimo_implement", () => {
  it("requires allowWrite=true before creating a job", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-implement-"));
    dirs.push(cwd);
    await expect(mimoImplement({ cwd, task: "Build it", allowWrite: false }, {
      env: {}, spawnJobSupervisor: vi.fn()
    })).rejects.toThrow();
    expect(fs.existsSync(path.join(cwd, ".codex-mimo"))).toBe(false);
  });

  it("stores write authorization and returns only a queued receipt", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-implement-"));
    dirs.push(cwd);
    const result = await mimoImplement({ cwd, task: "Build it", allowWrite: true }, {
      env: {}, spawnJobSupervisor: vi.fn().mockReturnValue(123)
    });
    expect(result).toEqual({
      jobId: expect.any(String), kind: "implement", status: "queued",
      actions: { status: "mimo_status", events: "mimo_events", result: "mimo_result", cancel: "mimo_cancel" }
    });
    expect(readJob(cwd, result.jobId)?.request).toEqual({
      cwd, task: "Build it", allowWrite: true, timeoutMs: 1_800_000, idleTimeoutMs: 90_000
    });
  });
});
