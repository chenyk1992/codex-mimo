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

import { mimoReview } from "../../../src/codex/tools.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-review-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("mimo_review", () => {
  beforeEach(() => {
    mocks.execa.mockReset();
    mocks.runAndCapture.mockReset();
  });

  it("writes diff to file and references it as attached in prompt", async () => {
    const cwd = tempWorkspace();
    const diff = "diff --git a/src/app.ts b/src/app.ts\n+const x = 1;\n";
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: diff, stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_rev1",
      summary: "Found one issue.",
      changedFiles: [],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: [{ type: "text" }]
    });

    const result = await mimoReview({ cwd, base: "HEAD" });

    expect(result.summary).toBe("Found one issue.");
    expect(result.findings).toHaveLength(1);
    const call = mocks.runAndCapture.mock.calls[0][0];
    expect(call.files).toHaveLength(1);
    expect(fs.readFileSync(call.files[0], "utf-8")).toBe(diff);
    expect(call.message).toContain("attached");
  });

  it("throws when git diff fails", async () => {
    const cwd = tempWorkspace();
    mocks.execa.mockResolvedValue({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: bad revision"
    });
    await expect(mimoReview({ cwd, base: "bad-ref" })).rejects.toThrow("Git diff capture failed");
    expect(mocks.runAndCapture).not.toHaveBeenCalled();
  });

  it("throws when review produces no output", async () => {
    const cwd = tempWorkspace();
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "diff --git a/a b/a\n", stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: null,
      summary: "Completed.",
      changedFiles: [],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: []
    });
    await expect(mimoReview({ cwd, base: "HEAD" })).rejects.toThrow("no review output");
  });

  it("uses inline prompt when git diff is empty", async () => {
    const cwd = tempWorkspace();
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_rev4",
      summary: "No issues found.",
      changedFiles: [],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: [{ type: "text" }]
    });

    const result = await mimoReview({ cwd, base: "HEAD" });

    expect(result.summary).toBe("No issues found.");
    const call = mocks.runAndCapture.mock.calls[0][0];
    expect(call.files).toBeUndefined();
    expect(call.message).toContain("No changes found.");
  });

  it("passes timeoutMs to MiMoCode review runner", async () => {
    const cwd = tempWorkspace();
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_timeout",
      summary: "No issues found.",
      changedFiles: [],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: [{ type: "text" }]
    });

    await mimoReview({ cwd, base: "HEAD", timeoutMs: 12345 });

    expect(mocks.runAndCapture.mock.calls[0][0]).toMatchObject({ timeoutMs: 12345 });
  });

  it("throws when agent returns a greeting instead of review content", async () => {
    const cwd = tempWorkspace();
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "diff --git a/a b/a\n+const x = 1;\n", stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_greeting",
      summary: "您好！您的消息似乎是空的。请问有什么我可以帮您的吗？",
      changedFiles: [],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: [{ type: "text" }]
    });
    await expect(mimoReview({ cwd, base: "HEAD" })).rejects.toThrow("greeting");
  });

  it("throws when agent returns an English greeting instead of review content", async () => {
    const cwd = tempWorkspace();
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "diff --git a/a b/a\n+const x = 1;\n", stderr: "" });
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_greeting_en",
      summary: "Hello! How can I help you today?",
      changedFiles: [],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: [{ type: "text" }]
    });
    await expect(mimoReview({ cwd, base: "HEAD" })).rejects.toThrow("greeting");
  });
});
