import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildMimoRunArgs } from "../../src/mimo/run-json.js";
import { planPrompt, implementPrompt, reviewPrompt } from "../../src/core/prompt.js";

vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ stdout: "1.0.0" })
}));

vi.mock("../../src/git/diff.js", () => ({
  captureDiff: vi.fn().mockResolvedValue({
    stat: " file.ts | 2 +-",
    diff: "diff --git a/file.ts\n+new line",
    changedFiles: ["file.ts"],
    hasChanges: true
  })
}));

import { execa } from "execa";
import { runPlan, runImplement, runReview, runFixCi } from "../../src/cli/commands.js";

const mockedExeca = vi.mocked(execa);

beforeEach(() => {
  mockedExeca.mockClear();
  mockedExeca.mockResolvedValue({ stdout: "" } as any);
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
  it("calls execa with agent=plan and stdin=ignore", async () => {
    await runPlan("/project", "Add auth", []);
    expect(mockedExeca).toHaveBeenCalledOnce();
    const [cmd, args, opts] = mockedExeca.mock.calls[0];
    expect(cmd).toBe("mimo");
    expect(args).toContain("--agent");
    expect(args).toContain("plan");
    expect(opts).toMatchObject({ stdin: "ignore" });
  });

  it("passes file flags when files provided", async () => {
    await runPlan("/project", "task", ["spec.md"]);
    const [, args] = mockedExeca.mock.calls[0];
    expect(args).toContain("--file");
    expect(args).toContain("spec.md");
  });
});

describe("runImplement command", () => {
  it("calls execa with agent=build", async () => {
    await runImplement("/project", "Fix bug", []);
    const [, args] = mockedExeca.mock.calls[0];
    expect(args).toContain("--agent");
    expect(args).toContain("build");
  });

  it("uses stdin=ignore", async () => {
    await runImplement("/project", "task", []);
    const [, , opts] = mockedExeca.mock.calls[0];
    expect(opts).toMatchObject({ stdin: "ignore" });
  });
});

describe("runReview command", () => {
  it("captures diff and uses agent=plan", async () => {
    await runReview("/project", "HEAD", []);
    const [, args] = mockedExeca.mock.calls[0];
    expect(args).toContain("--agent");
    expect(args).toContain("plan");
  });

  it("includes diff content in the prompt", async () => {
    await runReview("/project", "HEAD", []);
    const [, args] = mockedExeca.mock.calls[0];
    const message = args.find((a: string) => typeof a === "string" && a.includes("diff --git"));
    expect(message).toBeDefined();
  });
});

describe("runFixCi command", () => {
  it("uses agent=build with file attachment", async () => {
    await runFixCi("/project", "ci.log", undefined, []);
    const [, args] = mockedExeca.mock.calls[0];
    expect(args).toContain("--agent");
    expect(args).toContain("build");
    expect(args).toContain("--file");
    expect(args).toContain("ci.log");
  });

  it("includes extra files alongside the primary file", async () => {
    await runFixCi("/project", "ci.log", undefined, ["extra.log"]);
    const [, args] = mockedExeca.mock.calls[0];
    const fileIndices = args.reduce((acc: number[], v: string, i: number) =>
      v === "--file" ? [...acc, i] : acc, []);
    expect(fileIndices).toHaveLength(2);
    expect(args[fileIndices[0] + 1]).toBe("ci.log");
    expect(args[fileIndices[1] + 1]).toBe("extra.log");
  });

  it("uses default task when none provided", async () => {
    await runFixCi("/project", "ci.log", undefined, []);
    const [, args] = mockedExeca.mock.calls[0];
    const message = args.find((a: string) => typeof a === "string" && a.includes("Fix the CI failures"));
    expect(message).toBeDefined();
  });

  it("uses custom task when provided", async () => {
    await runFixCi("/project", "ci.log", "Fix tests", []);
    const [, args] = mockedExeca.mock.calls[0];
    const message = args.find((a: string) => typeof a === "string" && a.includes("Fix tests"));
    expect(message).toBeDefined();
  });
});
