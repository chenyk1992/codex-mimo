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
  });
});
