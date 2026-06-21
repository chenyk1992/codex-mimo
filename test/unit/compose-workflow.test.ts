import { describe, expect, it } from "vitest";
import { buildComposePrompt, getComposeWorkflow } from "../../src/compose/workflow.js";

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

    expect(prompt).toContain("@compose");
    expect(prompt).toContain("compose:execute");
    expect(prompt).toContain("doc/codex-mimo-acp-integration-plan.md");
    expect(prompt).toContain("Do not commit, push, reset, or delete files.");
  });
});
