import { describe, expect, it } from "vitest";
import { runComposeWorkflow } from "../../../src/compose/runner.js";

const baseDeps = () => ({
  runMimo: async () => ({
    stdout: '{"type":"message","text":"done"}\n',
    stderr: "",
    exitCode: 0
  }),
  captureDiff: async () => ({
    changedFiles: [] as string[],
    diffStat: "",
    diff: ""
  }),
  captureStatus: async () => ({
    short: "",
    dirty: false
  }),
  runVerification: async () => [] as never[],
  writeReport: () => undefined,
  now: () => new Date("2026-06-24T00:00:00.000Z")
});

describe("read-only enforcement", () => {
  it("brainstorm modifying files → failed + error message", async () => {
    let statusCalls = 0;
    const deps = {
      ...baseDeps(),
      captureDiff: async () => ({
        changedFiles: ["src/foo.ts"],
        diffStat: " src/foo.ts | 5 +++++",
        diff: "diff --git a/src/foo.ts b/src/foo.ts"
      }),
      captureStatus: async () => {
        statusCalls += 1;
        return statusCalls === 1
          ? { short: "", dirty: false }
          : { short: "?? src/foo.ts", dirty: true };
      }
    };

    const result = await runComposeWorkflow(
      {
        cwd: "E:/project",
        workflow: "brainstorm",
        task: "Clarify requirements",
        reportDir: "E:/project/.codex-mimo/reports"
      },
      deps
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Read-only workflow brainstorm modified files");
    expect(result.error).toContain("src/foo.ts");
  });

  it("plan creating untracked files → failed", async () => {
    let statusCalls = 0;
    const deps = {
      ...baseDeps(),
      captureDiff: async () => ({
        changedFiles: [] as string[],
        diffStat: "",
        diff: ""
      }),
      captureStatus: async () => {
        statusCalls += 1;
        return statusCalls === 1
          ? { short: "", dirty: false }
          : { short: "?? plan-output.md\n?? notes.txt", dirty: true };
      }
    };

    const result = await runComposeWorkflow(
      {
        cwd: "E:/project",
        workflow: "plan",
        task: "Write a plan",
        reportDir: "E:/project/.codex-mimo/reports"
      },
      deps
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Read-only workflow plan modified files");
    expect(result.error).toContain("plan-output.md");
    expect(result.error).toContain("notes.txt");
  });

  it("dev modifying files → allowed", async () => {
    const deps = {
      ...baseDeps(),
      captureDiff: async () => ({
        changedFiles: ["src/app.ts"],
        diffStat: " src/app.ts | 10 ++++++++++",
        diff: "diff --git a/src/app.ts b/src/app.ts"
      }),
      captureStatus: async () => ({
        short: " M src/app.ts",
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
      ]
    };

    const result = await runComposeWorkflow(
      {
        cwd: "E:/project",
        workflow: "dev",
        task: "Implement feature",
        reportDir: "E:/project/.codex-mimo/reports"
      },
      deps
    );

    expect(result.status).toBe("passed");
    expect(result.error).toBeUndefined();
    expect(result.changedFiles).toEqual(["src/app.ts"]);
  });
});
