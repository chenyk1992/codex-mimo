import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mimoPlan } from "../../../src/codex/tools.js";
import { readJob } from "../../../src/core/job-store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("mimo_plan", () => {
  it("stores the request and returns only a queued receipt", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-plan-"));
    dirs.push(cwd);
    const spawnJobWorker = vi.fn().mockReturnValue(123);
    const result = await mimoPlan({ cwd, task: "Plan it", model: "mimo-v2" }, {
      env: {}, spawnJobWorker
    });

    expect(result).toEqual({
      jobId: expect.any(String), kind: "plan", status: "queued",
      actions: { status: "mimo_status", events: "mimo_events", result: "mimo_result", cancel: "mimo_cancel" }
    });
    expect(readJob(cwd, result.jobId)?.request).toEqual({
      cwd, task: "Plan it", model: "mimo-v2", timeoutMs: 1_800_000
    });
    expect(spawnJobWorker).toHaveBeenCalledWith(cwd, result.jobId);
  });
});
