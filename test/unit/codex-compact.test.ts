import { describe, expect, it } from "vitest";
import { compactComposeReportForCodex } from "../../src/codex/compact.js";

describe("Codex compact compose report", () => {
  it("keeps the MCP response small and points Codex to persisted artifacts", () => {
    const result = compactComposeReportForCodex({
      id: "run_1",
      createdAt: "2026-06-22T10:00:00.000Z",
      workflow: "dev",
      cwd: "E:/project/app",
      task: "Implement login throttling",
      mimoArgs: ["run", "--format", "json", "--agent", "compose"],
      requestedSkills: ["compose:brainstorm", "compose:plan", "compose:tdd"],
      status: "passed",
      events: [
        { type: "message", text: "long implementation notes", raw: { type: "message" } },
        { type: "tool", toolName: "bash", status: "completed", raw: { type: "tool" } },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 20 }, raw: { type: "usage" } }
      ],
      changedFiles: ["src/login.ts"],
      diffStat: " src/login.ts | 10 ++++++++++",
      verification: [
        {
          command: "npm test",
          exitCode: 0,
          stdout: "very long stdout should stay on disk",
          stderr: "",
          passed: true,
          durationMs: 123
        }
      ],
      reviewText: "Review summary for Codex.",
      reportPaths: {
        json: "report.json",
        markdown: "report.md",
        eventsJsonl: "events.jsonl"
      }
    });

    expect(result).toMatchObject({
      id: "run_1",
      workflow: "dev",
      status: "passed",
      changedFiles: ["src/login.ts"],
      eventSummary: { messages: 1, tools: 1, diffs: 0, errors: 0 },
      verification: [{ command: "npm test", exitCode: 0, passed: true, durationMs: 123 }],
      reportPaths: {
        json: "report.json",
        markdown: "report.md",
        eventsJsonl: "events.jsonl"
      }
    });
    expect(result.summary).toContain("passed");
    expect(result.summary).toContain("1 changed file");
    expect(JSON.stringify(result)).not.toContain("very long stdout");
    expect(JSON.stringify(result)).not.toContain("long implementation notes");
    expect(result).not.toHaveProperty("events");
    expect(result).not.toHaveProperty("mimoArgs");
  });

  it("can include job-linked report paths without embedding events", () => {
    const result = compactComposeReportForCodex({
      id: "compose-1",
      createdAt: "2026-06-23T00:00:00.000Z",
      workflow: "dev",
      cwd: "E:/project/app",
      task: "Implement login throttling",
      mimoArgs: ["run"],
      requestedSkills: ["compose:brainstorm"],
      status: "passed",
      events: [{ type: "message", text: "done", raw: { type: "message", text: "done" } }],
      changedFiles: [],
      diffStat: "",
      verification: [],
      reportPaths: {
        json: "report.json",
        markdown: "report.md",
        eventsJsonl: "events.jsonl"
      }
    });

    expect(result.reportPaths.json).toBe("report.json");
    expect(result).not.toHaveProperty("events");
  });

  it("summarizes progress and last tool in compact compose reports", () => {
    const result = compactComposeReportForCodex({
      id: "run1",
      createdAt: "2026-06-24T00:00:00.000Z",
      workflow: "plan",
      cwd: "/tmp/project",
      task: "Plan",
      mimoArgs: ["run"],
      requestedSkills: ["compose:plan"],
      status: "timeout",
      events: [
        { type: "progress", progressKind: "step_start", text: "MiMoCode step started.", raw: {} },
        { type: "tool", toolName: "read", status: "completed", raw: {} }
      ],
      changedFiles: [],
      diffStat: "",
      verification: [],
      reportPaths: { json: "run.json", markdown: "run.md", eventsJsonl: "run.jsonl" }
    });

    expect(result.eventSummary).toMatchObject({
      progress: 1,
      tools: 1,
      lastEvent: "tool:read:completed",
      lastTool: "read"
    });
  });
});
