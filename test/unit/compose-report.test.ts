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

  it("renders git status before and after", () => {
    const markdown = renderMarkdownReport({
      id: "run_2",
      createdAt: "2026-06-21T18:40:00.000Z",
      workflow: "dev",
      cwd: "E:/project/app",
      task: "Test task",
      mimoArgs: ["run", "--agent", "compose"],
      requestedSkills: ["compose:tdd"],
      status: "passed",
      events: [],
      changedFiles: [],
      diffStat: "",
      verification: [],
      gitStatusBefore: { short: " M src/a.ts", dirty: true },
      gitStatusAfter: { short: "M  src/a.ts", dirty: true },
      reportPaths: {
        json: "report.json",
        markdown: "report.md",
        eventsJsonl: "events.jsonl"
      }
    });

    expect(markdown).toContain("## Git Status (Before)");
    expect(markdown).toContain("## Git Status (After)");
    expect(markdown).toContain("M src/a.ts");
  });

  it("renders git head movement and created commits", () => {
    const markdown = renderMarkdownReport({
      id: "run_head",
      createdAt: "2026-06-28T09:20:12.720Z",
      workflow: "plan",
      cwd: "E:/project/app",
      task: "Plan only",
      mimoArgs: ["run", "--agent", "compose"],
      requestedSkills: ["compose:plan"],
      status: "failed",
      events: [],
      changedFiles: ["src/pricing.js", "test/pricing.test.js"],
      diffStat: "",
      verification: [],
      gitHeadBefore: { oid: "2662087", short: "2662087", subject: "chore: seed vibe demo" },
      gitHeadAfter: { oid: "1672c89", short: "1672c89", subject: "feat: add discount code support" },
      gitCommits: [
        "7770acb test: add discount code test cases",
        "1672c89 feat: add discount code support"
      ],
      reportPaths: {
        json: "report.json",
        markdown: "report.md",
        eventsJsonl: "events.jsonl"
      }
    } as any);

    expect(markdown).toContain("## Git HEAD");
    expect(markdown).toContain("Before: `2662087 chore: seed vibe demo`");
    expect(markdown).toContain("After: `1672c89 feat: add discount code support`");
    expect(markdown).toContain("## Git Commits Created");
    expect(markdown).toContain("7770acb test: add discount code test cases");
    expect(markdown).toContain("1672c89 feat: add discount code support");
  });

  it("renders diff path when present", () => {
    const markdown = renderMarkdownReport({
      id: "run_3",
      createdAt: "2026-06-21T18:40:00.000Z",
      workflow: "dev",
      cwd: "E:/project/app",
      task: "Test task",
      mimoArgs: ["run", "--agent", "compose"],
      requestedSkills: ["compose:tdd"],
      status: "passed",
      events: [],
      changedFiles: ["src/a.ts"],
      diffStat: " src/a.ts | 5 +++++",
      verification: [],
      diffPath: ".codex-mimo/diffs/run_3.diff",
      reportPaths: {
        json: "report.json",
        markdown: "report.md",
        eventsJsonl: "events.jsonl"
      }
    });

    expect(markdown).toContain("## Full Diff");
    expect(markdown).toContain(".codex-mimo/diffs/run_3.diff");
  });

  it("renders error section when error present", () => {
    const markdown = renderMarkdownReport({
      id: "run_4",
      createdAt: "2026-06-21T18:40:00.000Z",
      workflow: "dev",
      cwd: "E:/project/app",
      task: "Test task",
      mimoArgs: ["run", "--agent", "compose"],
      requestedSkills: ["compose:tdd"],
      status: "failed",
      events: [],
      changedFiles: [],
      diffStat: "",
      verification: [],
      error: "MiMoCode startup failed: mimo not found",
      reportPaths: {
        json: "report.json",
        markdown: "report.md",
        eventsJsonl: "events.jsonl"
      }
    });

    expect(markdown).toContain("## Error");
    expect(markdown).toContain("MiMoCode startup failed: mimo not found");
  });

  it("renders callback summary when callback is present", () => {
    const markdown = renderMarkdownReport({
      id: "run_5",
      createdAt: "2026-06-21T18:40:00.000Z",
      workflow: "dev",
      cwd: "E:/project/app",
      task: "Test task",
      mimoArgs: ["run", "--agent", "compose"],
      requestedSkills: ["compose:tdd"],
      status: "passed",
      events: [],
      changedFiles: [],
      diffStat: "",
      verification: [],
      executionCallback: {
        invocationId: "compose-dev-1",
        outcome: "completed",
        sessionId: "ses_callback",
        receivedAt: "2026-06-21T18:41:00.000Z"
      },
      reportPaths: {
        json: "report.json",
        markdown: "report.md",
        eventsJsonl: "events.jsonl"
      }
    });

    expect(markdown).toContain("## Execution Callback");
    expect(markdown).toContain("Outcome: `completed`");
    expect(markdown).toContain("Session ID: `ses_callback`");
    expect(markdown).toContain("Received At: `2026-06-21T18:41:00.000Z`");
  });

  it("renders missing callback note when callback timed out", () => {
    const markdown = renderMarkdownReport({
      id: "run_6",
      createdAt: "2026-06-21T18:40:00.000Z",
      workflow: "dev",
      cwd: "E:/project/app",
      task: "Test task",
      mimoArgs: ["run", "--agent", "compose"],
      requestedSkills: ["compose:tdd"],
      status: "failed",
      events: [],
      changedFiles: [],
      diffStat: "",
      verification: [],
      executionCallback: {
        invocationId: "compose-dev-timeout",
        outcome: "missing"
      },
      reportPaths: {
        json: "report.json",
        markdown: "report.md",
        eventsJsonl: "events.jsonl"
      }
    });

    expect(markdown).toContain("## Execution Callback");
    expect(markdown).toContain("No session.post callback was received");
  });
});
