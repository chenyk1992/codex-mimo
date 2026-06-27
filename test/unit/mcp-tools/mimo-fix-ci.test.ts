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

import { mimoFixCi } from "../../../src/codex/tools.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-fixci-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("mimo_fix_ci", () => {
  beforeEach(() => {
    mocks.execa.mockReset();
    mocks.runAndCapture.mockReset();
  });

  it("returns summary and changedFiles on success", async () => {
    const cwd = tempWorkspace();
    const logFile = path.join(cwd, "ci.log");
    fs.writeFileSync(logFile, "FAIL test_login");
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_fix1",
      summary: "Fixed CI.",
      changedFiles: ["src/auth.ts"],
      commands: [{ command: "npm test", exitCode: 0 }],
      errors: [],
      exitCode: 0,
      raw: []
    });
    const result = await mimoFixCi({ cwd, file: logFile });
    expect(result.summary).toBe("Fixed CI.");
    expect(result.changedFiles).toContain("src/auth.ts");
  });

  it("passes file and default task to runAndCapture", async () => {
    const cwd = tempWorkspace();
    const logFile = path.join(cwd, "ci.log");
    fs.writeFileSync(logFile, "error output");
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_fix2",
      summary: "Done.",
      changedFiles: [],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: []
    });
    await mimoFixCi({ cwd, file: logFile });
    const call = mocks.runAndCapture.mock.calls[0][0];
    expect(call.files).toEqual([logFile]);
    expect(call.message).toContain("Fix the CI failures");
  });

  it("throws when direct MiMo run returns a nonzero exit code", async () => {
    const cwd = tempWorkspace();
    const logFile = path.join(cwd, "ci.log");
    fs.writeFileSync(logFile, "FAIL test_login");
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_fix_failed",
      summary: "Completed.",
      changedFiles: [],
      commands: [],
      errors: ["MiMoCode hook callback timed out before session.post was received."],
      exitCode: 1,
      raw: [],
      callbackTimedOut: true
    });

    await expect(mimoFixCi({ cwd, file: logFile }))
      .rejects.toThrow("MiMoCode fix-ci failed: MiMoCode hook callback timed out before session.post was received.");
  });

  it("uses custom task when provided", async () => {
    const cwd = tempWorkspace();
    const logFile = path.join(cwd, "ci.log");
    fs.writeFileSync(logFile, "error output");
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_fix3",
      summary: "Done.",
      changedFiles: [],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: []
    });
    await mimoFixCi({ cwd, file: logFile, task: "Fix the auth test only" });
    const call = mocks.runAndCapture.mock.calls[0][0];
    expect(call.message).toContain("Fix the auth test only");
  });
});
