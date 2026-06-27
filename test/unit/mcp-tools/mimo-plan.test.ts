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

  it("throws when direct MiMo run returns a nonzero exit code", async () => {
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_plan_failed",
      summary: "Completed.",
      changedFiles: [],
      commands: [],
      errors: ["MiMoCode hook callback timed out before session.post was received."],
      exitCode: 1,
      raw: [],
      callbackTimedOut: true
    });

    await expect(mimoPlan({ cwd: "/tmp/proj", task: "Add auth" }))
      .rejects.toThrow("MiMoCode plan failed: MiMoCode hook callback timed out before session.post was received.");
  });

  it("throws when MiMoCode asks for the missing task instead of producing a plan", async () => {
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_plan_clarify",
      summary: "\u60a8\u5df2\u8fdb\u5165\u8ba1\u5212\u6a21\u5f0f\uff0c\u4f46\u5c1a\u672a\u63d0\u4f9b\u5177\u4f53\u7684\u4efb\u52a1\u63cf\u8ff0\u3002\u8bf7\u95ee\u60a8\u60f3\u8981\u6211\u5e2e\u60a8\u89c4\u5212\u4ec0\u4e48\uff1f",
      changedFiles: [],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: []
    });

    await expect(mimoPlan({ cwd: "/tmp/proj", task: "Add auth" }))
      .rejects.toThrow("MiMoCode plan failed: MiMoCode did not receive or accept the task objective.");
  });

  it("throws when MiMoCode says only Objective was provided", async () => {
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_plan_objective_only",
      summary: "\u4f60\u7684\u6d88\u606f\u53ea\u5199\u4e86 \"Objective:\" \u4f46\u6ca1\u6709\u63d0\u4f9b\u5177\u4f53\u7684\u4efb\u52a1\u76ee\u6807\u3002\u8bf7\u544a\u8bc9\u6211\u4f60\u60f3\u8981\u5b8c\u6210\u4ec0\u4e48\uff1f",
      changedFiles: [],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: []
    });

    await expect(mimoPlan({ cwd: "/tmp/proj", task: "Add auth" }))
      .rejects.toThrow("MiMoCode plan failed: MiMoCode did not receive or accept the task objective.");
  });

  it("throws when MiMoCode asks what it should plan", async () => {
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_plan_mode_no_task",
      summary: "I see you've activated plan mode, but I don't see the actual task description. What would you like me to plan?",
      changedFiles: [],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: []
    });

    await expect(mimoPlan({ cwd: "/tmp/proj", task: "Add auth" }))
      .rejects.toThrow("MiMoCode plan failed: MiMoCode did not receive or accept the task objective.");
  });

  it("throws when MiMoCode says the Objective field is empty", async () => {
    mocks.runAndCapture.mockResolvedValue({
      sessionId: "ses_plan_empty_objective",
      summary: "What task would you like me to plan? The Objective field appears to be empty.",
      changedFiles: [],
      commands: [],
      errors: [],
      exitCode: 0,
      raw: []
    });

    await expect(mimoPlan({ cwd: "/tmp/proj", task: "Add auth" }))
      .rejects.toThrow("MiMoCode plan failed: MiMoCode did not receive or accept the task objective.");
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
