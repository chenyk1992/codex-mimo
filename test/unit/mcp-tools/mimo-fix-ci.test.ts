import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mimoFixCi } from "../../../src/codex/tools.js";
import { readJob } from "../../../src/core/job-store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("mimo_fix_ci", () => {
  it("stores the CI request and returns only a queued receipt", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-fix-ci-"));
    dirs.push(cwd);
    const result = await mimoFixCi({ cwd, file: "ci.log", task: "Fix tests" }, {
      env: {}, spawnJobSupervisor: vi.fn().mockReturnValue(123)
    });
    expect(result).toEqual({
      jobId: expect.any(String), kind: "fix-ci", status: "queued",
      actions: { status: "mimo_status", events: "mimo_events", result: "mimo_result", cancel: "mimo_cancel" }
    });
    expect(readJob(cwd, result.jobId)?.request).toEqual({
      cwd, file: "ci.log", task: "Fix tests", timeoutMs: 1_800_000
    });
  });
});
