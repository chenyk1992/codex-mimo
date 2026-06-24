import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ComposeInput,
  FixCiInput,
  ImplementInput,
  JobCancelInput,
  JobListInput,
  JobResultInput,
  JobStatusInput,
  PlanInput,
  ResumeInput,
  ResumeJobInput,
  ReviewInput
} from "../../src/codex/tool-schemas.js";
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

  it("accepts job management inputs", () => {
    expect(JobStatusInput.parse({ cwd: "E:/project/app", jobId: "compose-1" }).jobId).toBe("compose-1");
    expect(JobResultInput.parse({ cwd: "E:/project/app" }).cwd).toBe("E:/project/app");
    expect(JobCancelInput.parse({ cwd: "E:/project/app", jobId: "compose-1" }).jobId).toBe("compose-1");
    expect(JobListInput.parse({ cwd: "E:/project/app", all: true }).all).toBe(true);
  });

  it("accepts resume by job input", () => {
    const parsed = ResumeJobInput.parse({
      cwd: "E:/project/app",
      jobId: "compose-1",
      task: "Continue with the next fix"
    });
    expect(parsed.jobId).toBe("compose-1");
  });

  it("accepts background compose input", () => {
    const parsed = ComposeInput.parse({
      cwd: "E:/project/app",
      workflow: "dev",
      task: "Implement login throttling",
      background: true
    });
    expect(parsed.background).toBe(true);
  });

  it("rejects unknown fields on direct tool schemas", () => {
    expect(() => PlanInput.parse({ cwd: "E:/project/app", task: "Test", background: true })).toThrow();
    expect(() => ImplementInput.parse({ cwd: "E:/project/app", task: "Test", allowWrite: true, background: true })).toThrow();
    expect(() => ReviewInput.parse({ cwd: "E:/project/app", background: true })).toThrow();
    expect(() => FixCiInput.parse({ cwd: "E:/project/app", file: "log.txt", background: true })).toThrow();
    expect(() => ResumeInput.parse({ cwd: "E:/project/app", session: "s1", task: "Test", background: true })).toThrow();
  });

  it("accepts valid direct tool inputs without background/wait", () => {
    expect(PlanInput.parse({ cwd: "E:/project/app", task: "Test" }).task).toBe("Test");
    expect(ImplementInput.parse({ cwd: "E:/project/app", task: "Test", allowWrite: true }).allowWrite).toBe(true);
    expect(ReviewInput.parse({ cwd: "E:/project/app" }).base).toBe("HEAD");
    expect(FixCiInput.parse({ cwd: "E:/project/app", file: "log.txt" }).file).toBe("log.txt");
    expect(ResumeInput.parse({ cwd: "E:/project/app", session: "s1", task: "Test" }).session).toBe("s1");
  });
});
