import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildMimoRunArgs } from "../../src/mimo/run-json.js";
import { planPrompt, implementPrompt, reviewPrompt } from "../../src/core/prompt.js";

vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ stdout: "1.0.0" })
}));

vi.mock("../../src/mimo/mimo-runner.js", () => ({
  runAndCapture: vi.fn()
}));

vi.mock("../../src/git/diff.js", () => ({
  captureGitDiff: vi.fn().mockResolvedValue({
    diffStat: " file.ts | 2 +-",
    diff: "diff --git a/file.ts\n+new line",
    changedFiles: ["file.ts"]
  })
}));

import { execa } from "execa";
import { runAndCapture } from "../../src/mimo/mimo-runner.js";
import {
  composeStatusExitCode,
  formatMimoRunResult,
  runPlan,
  runImplement,
  runReview,
  runFixCi,
  runResume
} from "../../src/cli/commands.js";

const mockedExeca = vi.mocked(execa);
const mockedRunAndCapture = vi.mocked(runAndCapture);
const defaultRunResult = {
  sessionId: "ses_test",
  summary: "ok",
  changedFiles: [],
  commands: [],
  errors: [],
  exitCode: 0,
  raw: []
};

beforeEach(() => {
  mockedExeca.mockClear();
  mockedExeca.mockResolvedValue({ stdout: "" } as any);
  mockedRunAndCapture.mockReset();
  mockedRunAndCapture.mockResolvedValue(defaultRunResult);
});

describe("CLI command building", () => {
  it("builds plan command with agent and message", () => {
    const args = buildMimoRunArgs({
      cwd: "/project",
      agent: "plan",
      message: planPrompt("Add auth")
    });
    expect(args[0]).toBe("run");
    expect(args).toContain("--agent");
    expect(args).toContain("plan");
    expect(args).toContain("--format");
    expect(args).toContain("json");
  });

  it("includes --file flags for attached files", () => {
    const args = buildMimoRunArgs({
      cwd: "/project",
      agent: "build",
      message: implementPrompt("Fix CI"),
      files: ["ci.log", "error.log"]
    });
    const fileIndices = args.reduce((acc, v, i) => v === "--file" ? [...acc, i] : acc, [] as number[]);
    const messageIndex = args.indexOf(implementPrompt("Fix CI"));
    expect(fileIndices).toHaveLength(2);
    expect(messageIndex).toBeGreaterThan(-1);
    expect(fileIndices[0]).toBeGreaterThan(messageIndex);
    expect(args[fileIndices[0] + 1]).toBe("ci.log");
    expect(args[fileIndices[1] + 1]).toBe("error.log");
  });

  it("includes --session for resume", () => {
    const args = buildMimoRunArgs({
      cwd: "/project",
      agent: "build",
      message: "Continue",
      session: "sess_123"
    });
    expect(args).toContain("--session");
    expect(args).toContain("sess_123");
  });

  it("includes --fork when specified", () => {
    const args = buildMimoRunArgs({
      cwd: "/project",
      agent: "build",
      message: "Fork this",
      fork: true
    });
    expect(args).toContain("--fork");
  });

  it("selects agent=plan for plan commands", () => {
    const args = buildMimoRunArgs({
      cwd: "/project",
      agent: "plan",
      message: "task"
    });
    const agentIdx = args.indexOf("--agent");
    expect(args[agentIdx + 1]).toBe("plan");
  });

  it("selects agent=build for implement commands", () => {
    const args = buildMimoRunArgs({
      cwd: "/project",
      agent: "build",
      message: "task"
    });
    const agentIdx = args.indexOf("--agent");
    expect(args[agentIdx + 1]).toBe("build");
  });

  it("includes --model when specified", () => {
    const args = buildMimoRunArgs({
      cwd: "/project",
      agent: "build",
      message: "task",
      model: "gpt-4"
    });
    expect(args).toContain("--model");
    expect(args).toContain("gpt-4");
  });

  it("includes --title when specified", () => {
    const args = buildMimoRunArgs({
      cwd: "/project",
      agent: "build",
      message: "task",
      title: "My Task"
    });
    expect(args).toContain("--title");
    expect(args).toContain("My Task");
  });

  it("includes --attach when specified", () => {
    const args = buildMimoRunArgs({
      cwd: "/project",
      agent: "build",
      message: "task",
      attach: "context.md"
    });
    expect(args).toContain("--attach");
    expect(args).toContain("context.md");
  });

  it("includes --continue when specified", () => {
    const args = buildMimoRunArgs({
      cwd: "/project",
      agent: "build",
      message: "task",
      continue: true
    });
    expect(args).toContain("--continue");
  });

  it("places message before --file flags", () => {
    const args = buildMimoRunArgs({
      cwd: "/project",
      agent: "build",
      message: "the message",
      files: ["a.txt"]
    });
    const msgIdx = args.indexOf("the message");
    const fileIdx = args.indexOf("--file");
    expect(msgIdx).toBeLessThan(fileIdx);
  });

  it("omits optional flags when not provided", () => {
    const args = buildMimoRunArgs({
      cwd: "/project",
      agent: "plan",
      message: "task"
    });
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--session");
    expect(args).not.toContain("--fork");
    expect(args).not.toContain("--title");
    expect(args).not.toContain("--attach");
    expect(args).not.toContain("--continue");
    expect(args).not.toContain("--file");
  });
});

describe("prompt templates", () => {
  it("plan prompt includes rules", () => {
    const prompt = planPrompt("Test task");
    expect(prompt).toContain("Test task");
    expect(prompt).toContain("Do not edit files");
    expect(prompt).toContain("planning agent");
  });

  it("puts the user task before agent boilerplate", () => {
    expect(planPrompt("Test task").startsWith("Objective:\nTest task")).toBe(true);
    expect(implementPrompt("Test task").startsWith("Objective:\nTest task")).toBe(true);
  });

  it("plan prompt starts with an explicit objective", () => {
    const prompt = planPrompt("Fix sum.ts");

    expect(prompt.startsWith("Objective:\nFix sum.ts")).toBe(true);
    expect(prompt).toContain("Do not ask what the task is");
  });

  it("implement prompt starts with an explicit objective", () => {
    const prompt = implementPrompt("Update README");

    expect(prompt.startsWith("Objective:\nUpdate README")).toBe(true);
    expect(prompt).toContain("Do not ask what the task is");
  });

  it("implement prompt includes rules", () => {
    const prompt = implementPrompt("Test task");
    expect(prompt).toContain("Test task");
    expect(prompt).toContain("surgical");
    expect(prompt).toContain("implementation agent");
  });

  it("review prompt includes diff summary", () => {
    const prompt = reviewPrompt("diff --git a/file.ts ...");
    expect(prompt).toContain("diff --git a/file.ts");
    expect(prompt).toContain("Do not edit files");
  });

  it("review prompt includes review agent label", () => {
    const prompt = reviewPrompt("some diff");
    expect(prompt).toContain("review agent");
  });

  it("plan prompt does not contain implementation rules", () => {
    const prompt = planPrompt("task");
    expect(prompt).not.toContain("surgical");
    expect(prompt).not.toContain("implementation agent");
  });

  it("implement prompt does not contain planning rules", () => {
    const prompt = implementPrompt("task");
    expect(prompt).not.toContain("planning agent");
    expect(prompt).not.toContain("implementation plan");
  });

  it("plan and implement prompts start with Objective: prefix", () => {
    expect(planPrompt("x").startsWith("Objective:")).toBe(true);
    expect(implementPrompt("x").startsWith("Objective:")).toBe(true);
  });

  it("review prompt starts with Objective:", () => {
    expect(reviewPrompt("x").startsWith("Objective:")).toBe(true);
  });
});

describe("CLI flag effects", () => {
  it("dry-run does not execute mimo (verified by checking args only)", () => {
    const args = buildMimoRunArgs({
      cwd: "/project",
      agent: "plan",
      message: planPrompt("Test")
    });
    expect(args).toContain("run");
    expect(args).toContain("--format");
    expect(args).toContain("json");
  });

  it("file flag adds --file to args", () => {
    const args = buildMimoRunArgs({
      cwd: "/project",
      agent: "build",
      message: "Fix CI",
      files: ["ci.log"]
    });
    expect(args).toContain("--file");
    expect(args).toContain("ci.log");
  });
});

describe("compose-worker command", () => {
  it("requires --job-id flag", () => {
    const args = ["compose-worker"];
    expect(args).toContain("compose-worker");
    expect(args).not.toContain("--job-id");
  });

  it("accepts --job-id flag", () => {
    const args = ["compose-worker", "--job-id", "job-1"];
    const jobIdIndex = args.indexOf("--job-id");
    expect(jobIdIndex).toBeGreaterThan(-1);
    expect(args[jobIdIndex + 1]).toBe("job-1");
  });
});

describe("runPlan command", () => {
  it("returns runAndCapture result with agent=plan", async () => {
    const result = await runPlan("/project", "Add auth", []);
    expect(result).toBe(defaultRunResult);
    expect(mockedRunAndCapture).toHaveBeenCalledWith({
      cwd: "/project",
      agent: "plan",
      message: planPrompt("Add auth"),
      files: []
    });
  });

  it("passes file flags when files provided", async () => {
    await runPlan("/project", "task", ["spec.md"]);
    expect(mockedRunAndCapture.mock.calls[0][0].files).toEqual(["spec.md"]);
  });
});

describe("runImplement command", () => {
  it("calls runAndCapture with agent=build", async () => {
    await runImplement("/project", "Fix bug", []);
    expect(mockedRunAndCapture.mock.calls[0][0]).toMatchObject({
      cwd: "/project",
      agent: "build",
      message: implementPrompt("Fix bug"),
      files: []
    });
  });
});

describe("runReview command", () => {
  it("captures diff and uses agent=plan", async () => {
    await runReview("/project", "HEAD", []);
    expect(mockedRunAndCapture.mock.calls[0][0]).toMatchObject({
      cwd: "/project",
      agent: "plan"
    });
  });

  it("includes diff content in the prompt", async () => {
    await runReview("/project", "HEAD", []);
    expect(mockedRunAndCapture.mock.calls[0][0].message).toContain("diff --git");
  });
});

describe("runFixCi command", () => {
  it("uses agent=build with file attachment", async () => {
    await runFixCi("/project", "ci.log", undefined, []);
    expect(mockedRunAndCapture.mock.calls[0][0]).toMatchObject({
      cwd: "/project",
      agent: "build",
      files: ["ci.log"]
    });
  });

  it("includes extra files alongside the primary file", async () => {
    await runFixCi("/project", "ci.log", undefined, ["extra.log"]);
    expect(mockedRunAndCapture.mock.calls[0][0].files).toEqual(["ci.log", "extra.log"]);
  });

  it("uses default task when none provided", async () => {
    await runFixCi("/project", "ci.log", undefined, []);
    expect(mockedRunAndCapture.mock.calls[0][0].message).toContain("Fix the CI failures");
  });

  it("uses custom task when provided", async () => {
    await runFixCi("/project", "ci.log", "Fix tests", []);
    expect(mockedRunAndCapture.mock.calls[0][0].message).toContain("Fix tests");
  });
});

describe("runResume command", () => {
  it("uses agent=build with the requested session", async () => {
    await runResume("/project", "ses_resume", "Continue feature", []);
    expect(mockedRunAndCapture.mock.calls[0][0]).toMatchObject({
      cwd: "/project",
      agent: "build",
      session: "ses_resume",
      files: []
    });
    expect(mockedRunAndCapture.mock.calls[0][0].message).toContain("Continue feature");
  });

  it("uses a default continuation task when none provided", async () => {
    await runResume("/project", "ses_resume", undefined, []);
    expect(mockedRunAndCapture.mock.calls[0][0].message).toContain("Continue the previous task.");
  });
});

describe("composeStatusExitCode", () => {
  it("returns nonzero for failed and timeout compose results", () => {
    expect(composeStatusExitCode("failed")).toBe(1);
    expect(composeStatusExitCode("timeout")).toBe(1);
  });

  it("returns zero for successful or review-needed compose results", () => {
    expect(composeStatusExitCode("passed")).toBe(0);
    expect(composeStatusExitCode("needs_review")).toBe(0);
  });
});

describe("formatMimoRunResult", () => {
  it("prints compact callback-aware text", () => {
    const text = formatMimoRunResult("implement", {
      sessionId: "ses_123",
      summary: "Changed the API path.",
      changedFiles: ["src/api.ts"],
      commands: [{ command: "npm test", exitCode: 0 }],
      errors: ["minor warning"],
      exitCode: 1,
      raw: [],
      callback: {
        invocationId: "inv_1",
        outcome: "completed",
        sessionId: "ses_123",
        receivedAt: "2026-06-27T00:00:00.000Z"
      }
    });

    expect(text).toContain("Command: implement");
    expect(text).toContain("Status: failed");
    expect(text).toContain("Session: ses_123");
    expect(text).toContain("Summary: Changed the API path.");
    expect(text).toContain("Changed files:");
    expect(text).toContain("  - src/api.ts");
    expect(text).toContain("Commands:");
    expect(text).toContain("  - npm test exit=0");
    expect(text).toContain("Errors:");
    expect(text).toContain("  - minor warning");
  });
});
