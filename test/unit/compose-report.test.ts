import { describe, expect, it } from "vitest";
import { renderMarkdownReport } from "../../src/compose/report.js";

describe("compose report", () => {
  it("renders workflow, status, changed files, and verification", () => {
    const markdown = renderMarkdownReport({
      id: "run_1",
      createdAt: "2026-06-21T18:40:00.000Z",
      workflow: "dev",
      cwd: "E:/project/app",
      task: "Implement login throttling",
      mimoArgs: ["run", "--agent", "compose"],
      requestedSkills: ["compose:brainstorm", "compose:plan"],
      status: "passed",
      events: [],
      changedFiles: ["src/login.ts"],
      diffStat: " src/login.ts | 10 ++++++++++",
      verification: [
        {
          command: "npm test",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          passed: true,
          durationMs: 100
        }
      ],
      reportPaths: {
        json: "report.json",
        markdown: "report.md",
        eventsJsonl: "events.jsonl"
      }
    });

    expect(markdown).toContain("# Codex-MiMo Compose Report");
    expect(markdown).toContain("Status: `passed`");
    expect(markdown).toContain("src/login.ts");
    expect(markdown).toContain("npm test");
  });
});
