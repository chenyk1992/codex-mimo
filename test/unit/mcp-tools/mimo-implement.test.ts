import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execa: vi.fn(),
  runAndCapture: vi.fn()
}));

vi.mock("execa", () => ({ execa: mocks.execa }));
vi.mock("../../../src/mimo/mimo-runner.js", () => ({
  runAndCapture: mocks.runAndCapture
}));

import { mimoImplement, mimoStatus, mimoResult } from "../../../src/codex/tools.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-implement-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("mimo_implement", () => {
  beforeEach(() => {
    mocks.execa.mockReset();
    mocks.runAndCapture.mockReset();
  });

  it("throws when allowWrite is false", async () => {
    const cwd = tempWorkspace();
    await expect(
      mimoImplement({ cwd, task: "Add login", allowWrite: false })
    ).rejects.toThrow("allowWrite=true");
  });

  it("returns summary and changedFiles on success", async () => {
    const cwd = tempWorkspace();
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_impl1",
      summary: "Implemented login.",
      changedFiles: ["src/auth.ts"],
      commands: [{ command: "npm test", exitCode: 0 }],
      errors: [],
      exitCode: 0,
      raw: []
    });
    const result = await mimoImplement({ cwd, task: "Add login", allowWrite: true });
    expect(result.summary).toBe("Implemented login.");
    expect(result.changedFiles).toContain("src/auth.ts");
    expect(result.sessionId).toBe("ses_impl1");
  });

  it("propagates errors when mimo process crashes", async () => {
    const cwd = tempWorkspace();
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mocks.runAndCapture.mockRejectedValue(new Error("process killed"));
    await expect(
      mimoImplement({ cwd, task: "Add feature", allowWrite: true })
    ).rejects.toThrow("process killed");
  });

  it("throws and records a failed job when direct MiMo run returns nonzero exit code", async () => {
    const cwd = tempWorkspace();
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_impl_failed",
      summary: "Completed.",
      changedFiles: [],
      commands: [],
      errors: ["MiMoCode cancelled: blocked by hook"],
      exitCode: 1,
      raw: [],
      callback: {
        invocationId: "inv-impl-failed",
        event: "session.post",
        receivedAt: "2026-06-27T00:00:00.000Z",
        sessionId: "ses_impl_failed",
        outcome: "cancelled",
        error: "blocked by hook"
      }
    });

    await expect(
      mimoImplement({ cwd, task: "Add feature", allowWrite: true })
    ).rejects.toThrow("MiMoCode implement failed: MiMoCode cancelled: blocked by hook");

    const status = await mimoStatus({ cwd });
    expect(status.status).toBe("failed");
    expect(status.summary).toBe("MiMoCode implement failed: MiMoCode cancelled: blocked by hook");
  });

  it("returns empty changedFiles when worktree is clean", async () => {
    const cwd = tempWorkspace();
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_impl3",
      summary: "No changes needed.",
      changedFiles: [],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: []
    });
    const result = await mimoImplement({ cwd, task: "Review only", allowWrite: true });
    expect(result.changedFiles).toEqual([]);
  });

  it("creates a job record discoverable by mimo_status", async () => {
    const cwd = tempWorkspace();
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_impl_job",
      summary: "Done.",
      changedFiles: ["src/a.ts"],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: []
    });
    await mimoImplement({ cwd, task: "Add feature", allowWrite: true });

    const status = await mimoStatus({ cwd });
    expect(status.jobId).toMatch(/^implement-/);
    expect(status.status).toBe("completed");
    expect(status.sessionId).toBe("ses_impl_job");
  });

  it("creates a job record discoverable by mimo_result", async () => {
    const cwd = tempWorkspace();
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_impl_res",
      summary: "Feature added.",
      changedFiles: ["src/b.ts"],
      commands: [{ command: "npm test", exitCode: 0 }],
      errors: [],
      exitCode: 0,
      raw: []
    });
    await mimoImplement({ cwd, task: "Add feature", allowWrite: true });

    const result = await mimoResult({ cwd });
    expect(result.jobId).toMatch(/^implement-/);
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Feature added.");
  });
});
