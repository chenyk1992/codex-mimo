import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  runAndCapture: vi.fn()
}));

vi.mock("../../../src/mimo/mimo-runner.js", () => ({
  runAndCapture: mocks.runAndCapture
}));

import { mimoPlan } from "../../../src/codex/tools.js";

describe("mimo_plan", () => {
  beforeEach(() => {
    mocks.runAndCapture.mockReset();
  });

  it("returns summary, sessionId, changedFiles, and verification on success", async () => {
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_plan1",
      summary: "Plan created.",
      changedFiles: [],
      commands: [{ command: "npm test", exitCode: 0 }],
      errors: [],
      exitCode: 0,
      raw: []
    });
    const result = await mimoPlan({ cwd: "/tmp/proj", task: "Add auth" });
    expect(result.summary).toBe("Plan created.");
    expect(result.sessionId).toBe("ses_plan1");
    expect(result.changedFiles).toEqual([]);
    expect(result.verification).toEqual([{ command: "npm test", exitCode: 0 }]);
  });

  it("throws when runAndCapture rejects", async () => {
    mocks.runAndCapture.mockRejectedValue(new Error("mimo crashed"));
    await expect(mimoPlan({ cwd: "/tmp/proj", task: "Add auth" })).rejects.toThrow("mimo crashed");
  });

  it("builds prompt with Objective: prefix and task", async () => {
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_p2",
      summary: "Done.",
      changedFiles: [],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: []
    });
    await mimoPlan({ cwd: "/tmp/proj", task: "Implement OAuth2" });
    const call = mocks.runAndCapture.mock.calls[0][0];
    expect(call.message).toContain("Objective:");
    expect(call.message).toContain("Implement OAuth2");
    expect(call.message).toContain("planning agent");
  });

  it("passes agent and model overrides to runAndCapture", async () => {
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_p3",
      summary: "Done.",
      changedFiles: [],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: []
    });
    await mimoPlan({ cwd: "/tmp/proj", task: "Refactor", agent: "custom-plan", model: "gpt-4" });
    const call = mocks.runAndCapture.mock.calls[0][0];
    expect(call.agent).toBe("custom-plan");
    expect(call.model).toBe("gpt-4");
  });
});
