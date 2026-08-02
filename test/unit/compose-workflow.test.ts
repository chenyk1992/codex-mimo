import { describe, expect, it } from "vitest";
import {
  buildComposePrompt,
  getComposeWorkflow,
  listComposeWorkflows,
  workflowRequiresDevelopmentAcceptance,
  workflowSupportsBridgeSlicing
} from "../../src/compose/workflow.js";

describe("compose workflows", () => {
  it.each([
    ["dev", true],
    ["execute-plan", true],
    ["plan", false],
    ["fix", true],
    ["fix-ci", true],
    ["review", false]
  ] as const)("workflowRequiresDevelopmentAcceptance(%s) is %s", (workflow, expected) => {
    expect(workflowRequiresDevelopmentAcceptance(workflow)).toBe(expected);
  });

  it("returns dev workflow with expected Compose skill chain", () => {
    const workflow = getComposeWorkflow("dev");
    expect(workflow.skillChain).toEqual([
      "compose:brainstorm",
      "compose:plan",
      "compose:tdd",
      "compose:verify",
      "compose:review"
    ]);
    expect(workflow.writesAllowed).toBe(true);
  });

  it.each([
    ["brainstorm", false],
    ["plan", false],
    ["review", false],
    ["dev", true],
    ["fix", true],
    ["fix-ci", true],
    ["execute-plan", true],
    ["parallel", true],
    ["worktree", true],
    ["merge", true],
    ["new-skill", true]
  ] as const)("declares %s writesAllowed=%s", (workflow, expected) => {
    expect(getComposeWorkflow(workflow).writesAllowed).toBe(expected);
  });

  it("keeps plan read-only with task-only input", () => {
    expect(getComposeWorkflow("plan")).toMatchObject({
      writesAllowed: false,
      requiresTask: true,
      requiresFile: false
    });
  });

  it("builds an execute-plan prompt that references the plan file", () => {
    const prompt = buildComposePrompt({
      workflow: getComposeWorkflow("execute-plan"),
      task: "Execute the approved plan",
      file: "doc/codex-mimo-acp-integration-plan.md"
    });

    expect(prompt).toContain("compose:execute");
    expect(prompt).toContain("doc/codex-mimo-acp-integration-plan.md");
    expect(prompt).toContain("Do not commit, push, reset, or delete files.");
  });
});

describe("compose workflow official skill coverage", () => {
  it("covers the skills referenced from Compose workflows", () => {
    const usedSkills = new Set(listComposeWorkflows().flatMap((workflow) => workflow.skillChain));

    expect([...usedSkills].sort()).toEqual([
      "compose:brainstorm",
      "compose:debug",
      "compose:execute",
      "compose:feedback",
      "compose:merge",
      "compose:parallel",
      "compose:plan",
      "compose:review",
      "compose:subagent",
      "compose:tdd",
      "compose:verify",
      "compose:worktree"
    ]);
  });

  it("keeps plan focused on compose:plan only", () => {
    expect(getComposeWorkflow("plan").skillChain).toEqual(["compose:plan"]);
  });

  it("adds explicit workflows for brainstorm, worktree, merge, and new-skill", () => {
    expect(getComposeWorkflow("brainstorm").skillChain).toEqual(["compose:brainstorm"]);
    expect(getComposeWorkflow("worktree").skillChain).toEqual(["compose:worktree"]);
    expect(getComposeWorkflow("merge").skillChain).toEqual(["compose:merge"]);
    expect(getComposeWorkflow("new-skill").skillChain).toEqual(["compose:execute", "compose:verify"]);
  });
});

describe("compose prompt semantics", () => {
  it("puts the objective first in compose prompts", () => {
    const prompt = buildComposePrompt({
      workflow: getComposeWorkflow("plan"),
      task: "Fix .codex-mimo/plugin-smoke/sum.ts so it returns a + b."
    });

    expect(prompt.startsWith("Objective: Fix .codex-mimo/plugin-smoke/sum.ts")).toBe(true);
    expect(prompt).not.toContain("Objective:\n");
  });

  it("tells compose:plan to treat the objective as the requirement", () => {
    const prompt = buildComposePrompt({
      workflow: getComposeWorkflow("plan"),
      task: "Write an implementation plan for the smoke fixture."
    });

    expect(prompt).toContain("The Objective above is the requirement/spec for compose:plan.");
    expect(prompt).toContain("do not ask for a separate spec");
  });

  it("does not forbid questions for brainstorm workflow", () => {
    const prompt = buildComposePrompt({
      workflow: getComposeWorkflow("brainstorm"),
      task: "Clarify a new feature idea."
    });

    expect(prompt).toContain("Use compose:brainstorm to clarify the Objective.");
    expect(prompt).toContain("Assumptions and Unknowns");
    expect(prompt).toContain("Options and Tradeoffs");
    expect(prompt).toMatch(/idempotent.*repository evidence/i);
  });

  it("binds compose worktree to its bridge-owned current directory", () => {
    const prompt = buildComposePrompt({ workflow: getComposeWorkflow("worktree"), task: "Make an isolated edit." });
    expect(prompt).toContain("only bridge-owned worktree");
    expect(prompt).toContain("Do not create, remove, switch, checkout, branch, reset");
    expect(prompt).toContain("control workspace or any external directory");
  });

  it.each([
    ["dev", true],
    ["fix", true],
    ["execute-plan", true],
    ["fix-ci", false],
    ["parallel", false],
    ["worktree", false],
    ["merge", false],
    ["new-skill", false]
  ] as const)("workflowSupportsBridgeSlicing(%s) is %s", (workflow, expected) => {
    expect(workflowSupportsBridgeSlicing(workflow)).toBe(expected);
  });

  it("includes read-only constraint when writes are not allowed", () => {
    const prompt = buildComposePrompt({
      workflow: getComposeWorkflow("plan"),
      task: "Plan something."
    });

    expect(prompt).toContain("This workflow is read-only. Do not modify files.");
  });

  it("tells compose:plan not to save, execute, or commit the plan", () => {
    const prompt = buildComposePrompt({
      workflow: getComposeWorkflow("plan"),
      task: "Plan discount codes."
    });

    expect(prompt).toContain("Return the plan in your final response only");
    expect(prompt).toContain("Do not save plan files");
    expect(prompt).toContain("Do not invoke compose:execute");
    expect(prompt).toContain("Do not run implementation steps or commit");
  });
});
