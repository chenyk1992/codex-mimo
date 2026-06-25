import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execa: vi.fn(),
  runAndCapture: vi.fn(),
  runComposeWorkflow: vi.fn()
}));

vi.mock("execa", () => ({
  execa: mocks.execa
}));

vi.mock("../../src/mimo/mimo-runner.js", () => ({
  runAndCapture: mocks.runAndCapture
}));

vi.mock("../../src/compose/runner.js", () => ({
  runComposeWorkflow: mocks.runComposeWorkflow
}));

import { mimoCompose, mimoReview, mimoStatus, mimoResult } from "../../src/codex/tools.js";
import { MIMO_TOOL_NAMES } from "../../src/codex/mcp-server.js";
import { readJob, updateJob } from "../../src/core/job-store.js";

function buildComposeReport(overrides: Record<string, unknown> = {}) {
  return {
    id: "2026-01-01T00-00-00-000Z-compose-dev",
    createdAt: "2026-01-01T00:00:00.000Z",
    workflow: "dev",
    cwd: "/tmp/proj",
    task: "Test task",
    mimoArgs: [],
    requestedSkills: ["implement"],
    status: "passed",
    events: [],
    changedFiles: ["src/a.ts"],
    diffStat: "1 file changed",
    verification: [{ command: "npm test", exitCode: 0, passed: true, durationMs: 100 }],
    reportPaths: {
      json: "/tmp/proj/.codex-mimo/reports/report.json",
      markdown: "/tmp/proj/.codex-mimo/reports/report.md",
      eventsJsonl: "/tmp/proj/.codex-mimo/events/report.jsonl"
    },
    ...overrides
  };
}

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

  it("forwards AbortSignal to compose runner", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-compose-signal-"));
    const controller = new AbortController();
    mocks.runComposeWorkflow.mockResolvedValue(buildComposeReport());
    await mimoCompose({ cwd, workflow: "dev", task: "Test" }, {}, { signal: controller.signal });
    expect(mocks.runComposeWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it("passes dryRun to compose runner", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-compose-dry-"));
    mocks.runComposeWorkflow.mockResolvedValue(buildComposeReport({ status: "needs_review" }));
    const result = await mimoCompose({ cwd, workflow: "plan", task: "Plan only", dryRun: true });
    expect(mocks.runComposeWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true })
    );
    expect(result.status).toBe("needs_review");
  });

  it("includes planText in compact report when present", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-compose-plan-"));
    mocks.runComposeWorkflow.mockResolvedValue(buildComposeReport({
      planText: "## Implementation Plan\n1. Add auth\n2. Add tests"
    }));
    const result = await mimoCompose({ cwd, workflow: "plan", task: "Plan auth" });
    expect(result.planText).toContain("Implementation Plan");
  });

  it("handles already-aborted signal gracefully", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-compose-aborted-"));
    const controller = new AbortController();
    controller.abort();
    mocks.runComposeWorkflow.mockResolvedValue(buildComposeReport({ status: "failed", error: "Aborted" }));
    const result = await mimoCompose({ cwd, workflow: "dev", task: "Test" }, {}, { signal: controller.signal });
    expect(result.status).toBe("failed");
  });

  it("surfaces timeout status in compact report", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-compose-timeout-"));
    mocks.runComposeWorkflow.mockResolvedValue(buildComposeReport({
      status: "timeout",
      error: "MiMoCode process timed out after 1800000ms"
    }));
    const result = await mimoCompose({ cwd, workflow: "dev", task: "Long task" });
    expect(result.status).toBe("timeout");
    expect(result.error).toContain("timed out");
  });

  it("passes custom reportDir to compose runner", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-compose-reportdir-"));
    const customDir = path.join(cwd, "custom-reports");
    mocks.runComposeWorkflow.mockResolvedValue(buildComposeReport());
    await mimoCompose({ cwd, workflow: "dev", task: "Test", reportDir: customDir });
    expect(mocks.runComposeWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ reportDir: customDir })
    );
  });

  it("creates a job record for foreground compose discoverable by mimo_status", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-compose-fg-"));
    mocks.runComposeWorkflow.mockResolvedValue(buildComposeReport({
      sessionId: "ses_fg_compose",
      status: "passed"
    }));
    await mimoCompose({ cwd, workflow: "dev", task: "Implement feature" });

    const status = await mimoStatus({ cwd });
    expect(status.jobId).toMatch(/^compose-/);
    expect(status.status).toBe("completed");
    expect(status.sessionId).toBe("ses_fg_compose");
  });

  it("waits briefly for a background compose job when wait=true", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-wait-"));
    const result = await mimoCompose(
      { cwd, workflow: "plan", task: "Plan", background: true, wait: true },
      {
        spawnJobWorker: (jobCwd, kind, jobId) => {
          const job = readJob(jobCwd, jobId)!;
          updateJob(jobCwd, job.id, {
            status: "completed",
            phase: "done",
            completedAt: new Date().toISOString(),
            summary: "plan completed",
            reportPaths: { json: "run.json", markdown: "run.md", eventsJsonl: "run.jsonl" }
          });
          return 123;
        }
      }
    );

    expect(JSON.stringify(result)).toContain("plan completed");
  });
});
