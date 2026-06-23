import { describe, expect, it } from "vitest";
import { getComposeWorkflow } from "../../../src/compose/workflow.js";
import { runComposeWorkflow } from "../../../src/compose/runner.js";

const baseDeps = (overrides?: {
  runVerification?: () => Promise<{ command: string; exitCode: number; stdout: string; stderr: string; passed: boolean; durationMs: number }[]>;
  captureDiff?: () => Promise<{ changedFiles: string[]; diffStat: string; diff: string }>;
}) => ({
  runMimo: async () => ({
    stdout: '{"type":"message","text":"done"}\n',
    stderr: "",
    exitCode: 0
  }),
  captureDiff: overrides?.captureDiff ?? (async () => ({
    changedFiles: ["src/app.ts"],
    diffStat: " src/app.ts | 5 +++++",
    diff: "diff --git a/src/app.ts b/src/app.ts"
  })),
  captureStatus: async () => ({
    short: " M src/app.ts",
    dirty: true
  }),
  runVerification: overrides?.runVerification ?? (async () => [
    {
      command: "npm test",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      passed: true,
      durationMs: 10
    }
  ]),
  writeReport: () => undefined,
  now: () => new Date("2026-06-24T00:00:00.000Z")
});

describe("default verification", () => {
  it("dev workflow → default verification is ['npm test']", () => {
    const workflow = getComposeWorkflow("dev");
    expect(workflow.defaultVerification).toEqual(["npm test"]);
  });

  it("brainstorm → no default verification", () => {
    const workflow = getComposeWorkflow("brainstorm");
    expect(workflow.defaultVerification).toEqual([]);
  });

  it("custom verification overrides default", async () => {
    let capturedCommands: string[] = [];
    const deps = {
      ...baseDeps({
        runVerification: async () => {
          capturedCommands = ["echo custom"];
          return [
            {
              command: "echo custom",
              exitCode: 0,
              stdout: "custom",
              stderr: "",
              passed: true,
              durationMs: 5
            }
          ];
        }
      })
    };

    const result = await runComposeWorkflow(
      {
        cwd: "E:/project",
        workflow: "dev",
        task: "Test task",
        verification: ["echo custom"],
        reportDir: "E:/project/.codex-mimo/reports"
      },
      deps
    );

    expect(capturedCommands).toEqual(["echo custom"]);
    expect(result.status).toBe("passed");
  });

  it("all passed → status 'passed'", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project",
        workflow: "dev",
        task: "Test task",
        reportDir: "E:/project/.codex-mimo/reports"
      },
      baseDeps()
    );

    expect(result.status).toBe("passed");
    expect(result.verification).toHaveLength(1);
    expect(result.verification[0].passed).toBe(true);
    expect(result.verification[0].command).toBe("npm test");
  });
});
