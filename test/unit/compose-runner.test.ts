import { describe, expect, it } from "vitest";
import { runComposeWorkflow } from "../../src/compose/runner.js";

describe("compose runner", () => {
  it("runs MiMoCode, captures events, diff, verification, and report", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Implement login throttling",
        verification: ["npm test"],
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"message","text":"done"}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: ["src/login.ts"],
          diffStat: " src/login.ts | 10 ++++++++++",
          diff: "diff --git a/src/login.ts b/src/login.ts"
        }),
        captureStatus: async () => ({
          short: " M src/login.ts",
          dirty: true
        }),
        runVerification: async () => [
          {
            command: "npm test",
            exitCode: 0,
            stdout: "ok",
            stderr: "",
            passed: true,
            durationMs: 10
          }
        ],
        writeReport: () => undefined,
        now: () => new Date("2026-06-21T18:40:00.000Z")
      }
    );

    expect(result.status).toBe("passed");
    expect(result.changedFiles).toEqual(["src/login.ts"]);
    expect(result.events).toHaveLength(1);
    expect(result.gitStatusBefore).toBeDefined();
    expect(result.gitStatusAfter).toBeDefined();
    expect(result.diffPath).toBeDefined();
  });

  it("writes report on dry-run", async () => {
    let reportWritten = false;
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Test task",
        dryRun: true,
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        writeReport: () => { reportWritten = true; },
        now: () => new Date("2026-06-21T18:40:00.000Z")
      }
    );

    expect(result.status).toBe("needs_review");
    expect(reportWritten).toBe(true);
  });

  it("writes report when MiMoCode startup fails", async () => {
    let reportWritten = false;
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Test task",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => { throw new Error("mimo not found"); },
        writeReport: () => { reportWritten = true; },
        now: () => new Date("2026-06-21T18:40:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MiMoCode startup failed");
    expect(reportWritten).toBe(true);
  });

  it("writes report when git diff capture fails", async () => {
    let reportWritten = false;
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Test task",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"message","text":"done"}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => { throw new Error("not a git repo"); },
        writeReport: () => { reportWritten = true; },
        now: () => new Date("2026-06-21T18:40:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Git diff capture failed");
    expect(reportWritten).toBe(true);
  });

  it("writes report when verification fails", async () => {
    let reportWritten = false;
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Test task",
        verification: ["npm test"],
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"message","text":"done"}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: ["src/login.ts"],
          diffStat: " src/login.ts | 10 ++++++++++",
          diff: ""
        }),
        runVerification: async () => { throw new Error("test command not found"); },
        writeReport: () => { reportWritten = true; },
        now: () => new Date("2026-06-21T18:40:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Verification execution failed");
    expect(reportWritten).toBe(true);
  });

  it("marks status as failed when verification command fails", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Test task",
        verification: ["npm test"],
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"message","text":"done"}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: ["src/login.ts"],
          diffStat: " src/login.ts | 10 ++++++++++",
          diff: ""
        }),
        runVerification: async () => [
          {
            command: "npm test",
            exitCode: 1,
            stdout: "FAIL",
            stderr: "test failed",
            passed: false,
            durationMs: 100
          }
        ],
        writeReport: () => undefined,
        now: () => new Date("2026-06-21T18:40:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.verification[0].passed).toBe(false);
  });

  it("marks status as needs_review when no verification but files changed", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Test task",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"message","text":"done"}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: ["src/login.ts"],
          diffStat: " src/login.ts | 10 ++++++++++",
          diff: ""
        }),
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-21T18:40:00.000Z")
      }
    );

    expect(result.status).toBe("needs_review");
  });

  it("supports --continue flag", async () => {
    let capturedArgs: string[] = [];
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Continue task",
        continue: true,
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async (_cwd, args) => {
          capturedArgs = args;
          return {
            stdout: '{"type":"message","text":"done"}\n',
            stderr: "",
            exitCode: 0
          };
        },
        captureDiff: async () => ({
          changedFiles: [],
          diffStat: "",
          diff: ""
        }),
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-21T18:40:00.000Z")
      }
    );

    expect(capturedArgs).toContain("--continue");
    expect(result.status).toBe("passed");
  });
});
