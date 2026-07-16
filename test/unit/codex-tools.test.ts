import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mimoCompose,
  mimoFixCi,
  mimoImplement,
  mimoPlan,
  mimoReview
} from "../../src/codex/tools.js";
import { MIMO_TOOL_NAMES } from "../../src/codex/tool-names.js";
import type { JobKind } from "../../src/core/jobs.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("codex work tool handlers", () => {
  it.each([
    ["mimo_plan", "plan", (cwd: string, spawnJobWorker: () => number) =>
      mimoPlan({ cwd, task: "Plan it" }, { env: {}, spawnJobWorker })],
    ["mimo_implement", "implement", (cwd: string, spawnJobWorker: () => number) =>
      mimoImplement({ cwd, task: "Build it", allowWrite: true }, { env: {}, spawnJobWorker })],
    ["mimo_review", "review", (cwd: string, spawnJobWorker: () => number) =>
      mimoReview({ cwd, base: "HEAD" }, { env: {}, spawnJobWorker })],
    ["mimo_fix_ci", "fix-ci", (cwd: string, spawnJobWorker: () => number) =>
      mimoFixCi({ cwd, file: "ci.log", task: "Fix" }, { env: {}, spawnJobWorker })],
    ["mimo_compose", "compose", (cwd: string, spawnJobWorker: () => number) =>
      mimoCompose({ cwd, workflow: "dev", task: "Build" }, { env: {}, spawnJobWorker })]
  ] as const)("%s returns only a queued %s receipt", async (_name, kind: JobKind, run) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-work-tool-"));
    dirs.push(cwd);
    const spawnJobWorker = vi.fn().mockReturnValue(123);
    const result = await run(cwd, spawnJobWorker);
    expect(result).toEqual({
      jobId: expect.any(String),
      kind,
      status: "queued",
      actions: {
        status: "mimo_status",
        events: "mimo_events",
        result: "mimo_result",
        cancel: "mimo_cancel"
      }
    });
    expect(spawnJobWorker).toHaveBeenCalledWith(cwd, result.jobId);
  });

  it("exposes exactly the final 13-tool surface", () => {
    expect(MIMO_TOOL_NAMES).toEqual([
      "mimo_healthcheck",
      "mimo_plan",
      "mimo_implement",
      "mimo_review",
      "mimo_fix_ci",
      "mimo_resume",
      "mimo_compose",
      "mimo_status",
      "mimo_events",
      "mimo_wait",
      "mimo_result",
      "mimo_cancel",
      "mimo_jobs"
    ]);
    expect(MIMO_TOOL_NAMES).not.toContain("mimo_wake");
    expect(MIMO_TOOL_NAMES).not.toContain("mimo_resume_job");
  });
});
