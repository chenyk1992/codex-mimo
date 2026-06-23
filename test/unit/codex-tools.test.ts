import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execa: vi.fn(),
  runAndCapture: vi.fn()
}));

vi.mock("execa", () => ({
  execa: mocks.execa
}));

vi.mock("../../src/mimo/mimo-runner.js", () => ({
  runAndCapture: mocks.runAndCapture
}));

import { mimoCompose, mimoReview } from "../../src/codex/tools.js";
import { MIMO_TOOL_NAMES } from "../../src/codex/mcp-server.js";
import { readJob } from "../../src/core/job-store.js";

describe("codex tool handlers", () => {
  beforeEach(() => {
    mocks.execa.mockReset();
    mocks.runAndCapture.mockReset();
  });

  it("passes review diffs to MiMoCode as an attached file instead of an inline prompt", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-review-"));
    const diff = "diff --git a/src/app.ts b/src/app.ts\n+const value = 1;\n";
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: diff, stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_123",
      summary: "No findings.",
      changedFiles: [],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: [{ type: "text" }]
    });

    const result = await mimoReview({ cwd, base: "HEAD" });

    expect(result.findings).toHaveLength(1);
    expect(mocks.runAndCapture).toHaveBeenCalledTimes(1);
    const runInput = mocks.runAndCapture.mock.calls[0][0];
    expect(runInput.files).toHaveLength(1);
    expect(fs.readFileSync(runInput.files[0], "utf-8")).toBe(diff);
    expect(runInput.message).toContain("attached");
    expect(runInput.message).not.toContain(diff);
  });

  it("fails review when MiMoCode execution fails", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-review-"));
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "diff --git a/a b/a\n", stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: null,
      summary: "Completed.",
      changedFiles: [],
      commands: [],
      errors: ["command line too long"],
      exitCode: 1,
      raw: []
    });

    await expect(mimoReview({ cwd, base: "HEAD" })).rejects.toThrow("MiMoCode review failed");
  });

  it("returns a clear error when git diff capture fails", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-review-"));
    mocks.execa.mockResolvedValue({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: bad revision 'missing'"
    });

    await expect(mimoReview({ cwd, base: "missing" })).rejects.toThrow("Git diff capture failed");
    expect(mocks.runAndCapture).not.toHaveBeenCalled();
  });

  it("starts compose in background and returns a job launch response", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-compose-bg-"));
    const result = await mimoCompose(
      {
        cwd,
        workflow: "dev",
        task: "Implement login throttling",
        background: true
      },
      {
        spawnJobWorker: () => 999
      }
    );

    expect(result).toMatchObject({
      status: "queued",
      phase: "queued",
      actions: {
        status: "mimo_status",
        result: "mimo_result",
        cancel: "mimo_cancel"
      }
    });
    expect(result.jobId).toMatch(/^compose-/);
  });

  it("marks job as failed when background worker exits prematurely", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-compose-exit-"));
    let capturedOnExit: ((code: number | null, signal: string | null) => void) | undefined;

    await mimoCompose(
      {
        cwd,
        workflow: "dev",
        task: "Some task",
        background: true
      },
      {
        spawnJobWorker: (_cwd, _kind, _jobId, options) => {
          capturedOnExit = options?.onExit;
          return 999;
        }
      }
    );

    expect(capturedOnExit).toBeDefined();
    capturedOnExit!(1, null);

    const jobs = fs.readdirSync(path.join(cwd, ".codex-mimo", "jobs"))
      .filter((f) => f.endsWith(".json") && f !== "state.json");
    expect(jobs).toHaveLength(1);
    const job = JSON.parse(fs.readFileSync(path.join(cwd, ".codex-mimo", "jobs", jobs[0]), "utf-8"));
    expect(job.status).toBe("failed");
    expect(job.errorCode).toBe("worker_exit");
  });

  it("registers all job runtime MCP tools", () => {
    const toolNames = [...MIMO_TOOL_NAMES];
    expect(toolNames).toContain("mimo_status");
    expect(toolNames).toContain("mimo_result");
    expect(toolNames).toContain("mimo_cancel");
    expect(toolNames).toContain("mimo_jobs");
    expect(toolNames).toContain("mimo_resume_job");
  });
});
