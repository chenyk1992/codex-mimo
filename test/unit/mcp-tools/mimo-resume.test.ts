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

import { mimoResume } from "../../../src/codex/tools.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-resume-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("mimo_resume", () => {
  beforeEach(() => {
    mocks.execa.mockReset();
    mocks.runAndCapture.mockReset();
  });

  it("returns summary and sessionId on success", async () => {
    const cwd = tempWorkspace();
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_resume1",
      summary: "Resumed and completed.",
      changedFiles: ["src/feature.ts"],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: []
    });
    const result = await mimoResume({ cwd, session: "ses_resume1", task: "Continue work" });
    expect(result.summary).toBe("Resumed and completed.");
    expect(result.sessionId).toBe("ses_resume1");
    expect(result.changedFiles).toContain("src/feature.ts");
  });

  it("propagates errors when session is invalid", async () => {
    const cwd = tempWorkspace();
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mocks.runAndCapture.mockRejectedValue(new Error("session not found"));
    await expect(
      mimoResume({ cwd, session: "bad_session", task: "Continue" })
    ).rejects.toThrow("session not found");
  });

  it("passes task and session directly to runAndCapture", async () => {
    const cwd = tempWorkspace();
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_r3",
      summary: "Done.",
      changedFiles: [],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: []
    });
    await mimoResume({ cwd, session: "ses_r3", task: "Fix the bug" });
    const call = mocks.runAndCapture.mock.calls[0][0];
    expect(call.message).toBe("Fix the bug");
    expect(call.session).toBe("ses_r3");
  });
});
