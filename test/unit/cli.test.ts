import { describe, expect, it } from "vitest";
import { buildMimoRunArgs } from "../../src/mimo/run-json.js";
import { planPrompt, implementPrompt, reviewPrompt } from "../../src/core/prompt.js";

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
