import { describe, expect, it, vi } from "vitest";

import {
  runDevelopmentAcceptance,
  type DevelopmentAcceptancePlan
} from "../../../src/compose/acceptance.js";
import type { VerificationCommandExecutor } from "../../../src/compose/verify.js";

function makeExecutor(
  handler: (
    file: string,
    args: string[]
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
): VerificationCommandExecutor {
  return (file, args) => handler(file, args);
}

function makePlan(
  overrides: Partial<DevelopmentAcceptancePlan> = {}
): DevelopmentAcceptancePlan {
  return {
    source: "explicit",
    stages: [
      { stage: "build", commands: ["npm run build"], required: true },
      { stage: "test", commands: ["npm test"], required: true },
      { stage: "diff_check", commands: [], required: true }
    ],
    ...overrides
  };
}

describe("runDevelopmentAcceptance", () => {
  it("skips tests when build fails", async () => {
    const execute = makeExecutor(async (file, args) => {
      if (file === "npm" && args[0] === "run" && args[1] === "build") {
        return { exitCode: 1, stdout: "", stderr: "error TS2345: Build failed" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await runDevelopmentAcceptance("/tmp/project", makePlan(), { execute });

    expect(result.passed).toBe(false);
    expect(result.errorCode).toBe("build_failed");
    expect(result.failedStage).toBe("build");
    expect(result.failedCommand).toBe("npm run build");
    expect(result.stages.find((stage) => stage.stage === "test")?.outcome).toBe("skipped");
    expect(result.stages.find((stage) => stage.stage === "diff_check")?.outcome).toBe("skipped");
    expect(result.compactTests).toEqual([
      {
        stage: "build",
        outcome: "failed",
        command: "npm run build"
      }
    ]);
  });

  it("maps legacy verification failure to tests_failed", async () => {
    const plan = makePlan({
      source: "legacy_verification",
      stages: [
        { stage: "build", commands: ["npm run build"], required: true },
        { stage: "test", commands: ["npm test -- focused.test.ts"], required: true },
        { stage: "diff_check", commands: [], required: true }
      ]
    });

    const execute = makeExecutor(async (file, args) => {
      const command = [file, ...args].join(" ");
      if (command.includes("build")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.includes("test")) {
        return { exitCode: 1, stdout: "", stderr: "AssertionError: expected true to be false" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const runDiffCheck = vi.fn(async () => ({
      stage: "diff_check" as const,
      outcome: "passed" as const
    }));

    const result = await runDevelopmentAcceptance("/tmp/project", plan, {
      execute,
      runDiffCheck
    });

    expect(result.passed).toBe(false);
    expect(result.errorCode).toBe("tests_failed");
    expect(result.failedStage).toBe("test");
    expect(result.failedCommand).toBe("npm test -- focused.test.ts");
    expect(runDiffCheck).not.toHaveBeenCalled();
    expect(result.stages.find((stage) => stage.stage === "diff_check")?.outcome).toBe("skipped");
  });

  it("extracts vitest failed test names into suggestion", async () => {
    const vitestOutput = `
 ❯ test/unit/payment.test.ts (2 tests | 1 failed)
   × rejects invalid signature
   ✓ accepts valid signature

 FAIL  test/unit/payment.test.ts > rejects invalid signature
`;

    const plan = makePlan({
      source: "detected",
      stages: [
        {
          stage: "build",
          commands: [],
          notApplicableReason: "non_compiled_or_no_build_tooling",
          required: false
        },
        { stage: "test", commands: ["npm test"], required: true },
        { stage: "diff_check", commands: [], required: true }
      ]
    });

    const execute = makeExecutor(async () => ({
      exitCode: 1,
      stdout: vitestOutput,
      stderr: ""
    }));

    const runDiffCheck = vi.fn(async () => ({
      stage: "diff_check" as const,
      outcome: "passed" as const
    }));

    const result = await runDevelopmentAcceptance("/tmp/project", plan, {
      execute,
      runDiffCheck
    });

    expect(result.passed).toBe(false);
    expect(result.errorCode).toBe("tests_failed");
    expect(result.failedTests).toContain("rejects invalid signature");
    expect(result.suggestion).toMatch(/rejects invalid signature/);
    expect(result.suggestion).toMatch(/npm test/);
    expect(runDiffCheck).not.toHaveBeenCalled();
    expect(result.compactTests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "build",
          outcome: "not_applicable"
        }),
        expect.objectContaining({
          stage: "test",
          outcome: "failed",
          command: "npm test"
        })
      ])
    );
  });
});
