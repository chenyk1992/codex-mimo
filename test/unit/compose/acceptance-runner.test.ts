import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

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

  it("reuses exact successful MiMo command evidence after the last write", async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const runDiffCheck = vi.fn(async () => ({
      stage: "diff_check" as const,
      outcome: "passed" as const
    }));

    const result = await runDevelopmentAcceptance("/tmp/project", makePlan(), {
      execute,
      runDiffCheck,
      finalRepositoryFingerprint: "final-fingerprint",
      commandEvidence: [
        {
          command: "npm run build",
          cwd: "/tmp/project",
          exitCode: 0,
          eventIndex: 5,
          afterLastWrite: true,
          repositoryFingerprint: "final-fingerprint"
        },
        {
          command: "npm test",
          cwd: "/tmp/project",
          exitCode: 0,
          eventIndex: 6,
          afterLastWrite: true,
          repositoryFingerprint: "final-fingerprint"
        }
      ]
    });

    expect(result.passed).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(runDiffCheck).toHaveBeenCalledOnce();
    expect(result.verificationDetails).toEqual([
      expect.objectContaining({ command: "npm run build", source: "mimo_event", passed: true }),
      expect.objectContaining({ command: "npm test", source: "mimo_event", passed: true })
    ]);
  });

  it("reruns acceptance when matching evidence predates the last write", async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));

    await runDevelopmentAcceptance("/tmp/project", makePlan({
      stages: [{ stage: "test", commands: ["npm test"], required: true }]
    }), {
      execute,
      finalRepositoryFingerprint: "final-fingerprint",
      commandEvidence: [{
        command: "npm test",
        cwd: "/tmp/project",
        exitCode: 0,
        eventIndex: 1,
        afterLastWrite: false
      }]
    });

    expect(execute).toHaveBeenCalledOnce();
  });

  it("reruns acceptance when evidence belongs to another repository state", async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));

    await runDevelopmentAcceptance("/tmp/project", makePlan({
      stages: [{ stage: "test", commands: ["npm test"], required: true }]
    }), {
      execute,
      finalRepositoryFingerprint: "final-fingerprint",
      commandEvidence: [{
        command: "npm test",
        cwd: "/tmp/project",
        exitCode: 0,
        eventIndex: 2,
        afterLastWrite: true,
        repositoryFingerprint: "older-fingerprint"
      }]
    });

    expect(execute).toHaveBeenCalledOnce();
  });

  it("reuses redacted persisted evidence through its command hash", async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const command = "npm test -- --token secret";
    const commandHash = crypto.createHash("sha256").update(command).digest("hex");

    await runDevelopmentAcceptance("/tmp/project", makePlan({
      stages: [{ stage: "test", commands: [command], required: true }]
    }), {
      execute,
      finalRepositoryFingerprint: "final-fingerprint",
      commandEvidence: [{
        command: "npm test -- --token [REDACTED]",
        commandHash,
        cwd: "/tmp/project",
        exitCode: 0,
        eventIndex: 2,
        afterLastWrite: true,
        repositoryFingerprint: "final-fingerprint"
      }]
    });

    expect(execute).not.toHaveBeenCalled();
  });
});
