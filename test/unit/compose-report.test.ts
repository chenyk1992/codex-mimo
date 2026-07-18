import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMimoJsonLines } from "../../src/compose/events.js";
import {
  createComposeReport,
  renderMarkdownReport,
  writeComposeReport
} from "../../src/compose/report.js";

describe("compose report", () => {
  it("extracts structured plan text from normalized events", () => {
    const plan = "# Implementation Plan\n\n## Task 1: Setup\n\n- [ ] Create files\n- [ ] Run tests";
    const report = createReport([
      "Analyzing codebase...",
      plan
    ]);

    expect(report.planText).toBe(plan);
    expect(report.reviewText).toContain("Analyzing codebase...");
    expect(report.reviewText).toContain("Implementation Plan");
  });

  it("leaves plan text absent for ordinary result messages", () => {
    const report = createReport(["Found the bug in line 42"]);

    expect(report.planText).toBeUndefined();
    expect(report.reviewText).toBe("Found the bug in line 42");
  });

  it("excludes Compose startup chatter from structured plan text", () => {
    const report = createReport([
      "I'm using the compose:plan skill to create an implementation plan for your task.",
      "# Implementation Plan\n\n## Task 1: Setup\n\n- [ ] Create files"
    ]);

    expect(report.planText).toContain("Implementation Plan");
    expect(report.planText).not.toContain("compose:plan skill");
  });

  it("omits task and prompt arguments from persisted JSON and Markdown reports", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-report-redaction-"));
    const secret = "ghp_report_prompt_secret_123";
    try {
      const unsafeInput = {
        id: "secret-report",
        createdAt: "2026-07-18T00:00:00.000Z",
        workflow: "dev" as const,
        cwd: root,
        task: `Implement ${secret}`,
        mimoArgs: ["run", "--format", "json", `Objective: Implement ${secret}`],
        requestedSkills: ["compose:tdd"],
        status: "passed",
        events: [],
        diff: { changedFiles: [], diffStat: "", diff: "" },
        verification: [],
        reportDir: path.join(root, "reports"),
        eventsDir: path.join(root, "events"),
        diffsDir: path.join(root, "diffs")
      };
      const report = createComposeReport(unsafeInput);

      writeComposeReport(report);

      expect(report).not.toHaveProperty("task");
      expect(report).not.toHaveProperty("mimoArgs");
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(fs.readFileSync(report.reportPaths.json, "utf8")).not.toContain(secret);
      expect(fs.readFileSync(report.reportPaths.markdown, "utf8")).not.toContain(secret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders workflow, status, changed files, and verification", () => {
    const markdown = renderMarkdownReport({
      id: "run_1",
      createdAt: "2026-06-21T18:40:00.000Z",
      workflow: "dev",
      cwd: "E:/project/app",
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

function createReport(messages: string[]) {
  return createComposeReport({
    id: "plan-report",
    createdAt: "2026-06-23T00:00:00.000Z",
    workflow: "plan",
    cwd: "E:/project/app",
    requestedSkills: ["compose:plan"],
    status: "passed",
    events: parseMimoJsonLines(messages.map((text) => JSON.stringify({ type: "message", text })).join("\n")),
    diff: { changedFiles: [], diffStat: "", diff: "" },
    verification: [],
    reportDir: "E:/project/app/.codex-mimo/reports",
    eventsDir: "E:/project/app/.codex-mimo/events",
    diffsDir: "E:/project/app/.codex-mimo/diffs"
  });
}
