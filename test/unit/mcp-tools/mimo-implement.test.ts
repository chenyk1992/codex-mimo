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

import { mimoImplement } from "../../../src/codex/tools.js";

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
});
