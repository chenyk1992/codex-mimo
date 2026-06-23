import { describe, expect, it } from "vitest";
import { buildComposePrompt, getComposeWorkflow, listComposeWorkflows } from "../../src/compose/workflow.js";

describe("compose workflows", () => {
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
  it("covers all official MiMo Code Compose skills", () => {
    const usedSkills = new Set(listComposeWorkflows().flatMap((workflow) => workflow.skillChain));

    expect([...usedSkills].sort()).toEqual([
      "compose:brainstorm",
      "compose:debug",
      "compose:execute",
      "compose:feedback",
      "compose:merge",
      "compose:new-skill",
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
    expect(getComposeWorkflow("new-skill").skillChain).toEqual(["compose:new-skill"]);
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
  });

  it("includes read-only constraint when writes are not allowed", () => {
    const prompt = buildComposePrompt({
      workflow: getComposeWorkflow("plan"),
      task: "Plan something."
    });

    expect(prompt).toContain("This workflow is read-only. Do not modify files.");
  });
});
