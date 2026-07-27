import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mimoReview } from "../../../src/codex/tools.js";
import { readJob } from "../../../src/core/job-store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("mimo_review", () => {
  it("stores the review base without capturing a diff in the handler", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-review-"));
    dirs.push(cwd);
    const result = await mimoReview({ cwd, base: "main" }, {
      env: {}, spawnJobSupervisor: vi.fn().mockReturnValue(123)
    });
    expect(result).toEqual({
      jobId: expect.any(String), kind: "review", status: "queued",
      actions: { status: "mimo_status", events: "mimo_events", result: "mimo_result", cancel: "mimo_cancel" }
    });
    expect(readJob(cwd, result.jobId)?.request).toEqual({
      cwd, base: "main", timeoutMs: 1_800_000, idleTimeoutMs: 1_800_000,
      progressWarningMs: 120_000, progressTimeoutMs: 300_000
    });
  });
});
