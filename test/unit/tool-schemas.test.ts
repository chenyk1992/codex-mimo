import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ComposeInput } from "../../src/codex/tool-schemas.js";
import { COMPOSE_WORKFLOW_NAMES, composeWorkflowUsage } from "../../src/compose/workflow-names.js";

describe("tool schemas", () => {
  it("accepts all supported compose workflows", () => {
    for (const workflow of COMPOSE_WORKFLOW_NAMES) {
      expect(() => ComposeInput.parse({ cwd: "E:/project/app", workflow, task: "Test task" })).not.toThrow();
    }
  });

  it("formats compose workflow usage from the shared workflow list", () => {
    expect(composeWorkflowUsage()).toBe(
      "brainstorm|dev|fix|fix-ci|plan|execute-plan|review|parallel|worktree|merge|new-skill"
    );
  });

  it("uses the shared workflow schema in the MCP server registration", () => {
    const mcpServerSource = readFileSync("src/codex/mcp-server.ts", "utf8");

    expect(mcpServerSource).toContain("workflow: ComposeWorkflowSchema");
    expect(mcpServerSource).not.toContain('workflow: z.enum(["dev"');
  });

  it("rejects unknown workflow names", () => {
    expect(() =>
      ComposeInput.parse({ cwd: "E:/project/app", workflow: "unknown", task: "Test task" })
    ).toThrow();
  });

  it("accepts a positive compose timeout", () => {
    expect(
      ComposeInput.parse({ cwd: "E:/project/app", workflow: "dev", task: "Test task", timeoutMs: 110000 }).timeoutMs
    ).toBe(110000);
  });
});
