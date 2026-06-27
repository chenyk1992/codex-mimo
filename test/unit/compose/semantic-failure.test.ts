import { describe, expect, it } from "vitest";
import { runComposeWorkflow } from "../../../src/compose/runner.js";

const completedHook = {
  createHookCallbackController: async () => ({
    invocationId: "compose-test",
    token: "token",
    endpoint: "http://127.0.0.1:1/mimo-hook",
    configDir: "hook-dir",
    callbackFile: "callback.json",
    env: {},
    waitForCallback: async () => ({
      invocationId: "compose-test",
      event: "session.post" as const,
      outcome: "completed" as const,
      sessionId: "ses_test",
      receivedAt: "2026-06-24T00:00:00.000Z"
    }),
    close: async () => undefined
  })
};

function makeMimoStdout(text: string): string {
  return JSON.stringify({ type: "message", text }) + "\n";
}

const baseDeps = (stdout: string) => ({
  ...completedHook,
  runMimo: async () => ({
    stdout,
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

describe("semantic failure detection", () => {
  it("detects 'What would you like me to help?' as failure", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project",
        workflow: "plan",
        task: "Write a plan",
        reportDir: "E:/project/.codex-mimo/reports"
      },
      baseDeps(makeMimoStdout("What would you like me to help with?"))
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MiMoCode did not receive or accept the task objective");
  });

  it("detects 'How can I help you?' as failure", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project",
        workflow: "brainstorm",
        task: "Clarify requirements",
        reportDir: "E:/project/.codex-mimo/reports"
      },
      baseDeps(makeMimoStdout("How can I help you?"))
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MiMoCode did not receive or accept the task objective");
  });

  it("detects 'message got cut off' as failure", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project",
        workflow: "plan",
        task: "Write a plan",
        reportDir: "E:/project/.codex-mimo/reports"
      },
      baseDeps(makeMimoStdout("It looks like your message got cut off. Could you resend?"))
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MiMoCode did not receive or accept the task objective");
  });

  it("does not detect normal code with ``` as failure", async () => {
    const codeMessage = "Here's the fix:\n```typescript\nexport function add(a: number, b: number) {\n  return a + b;\n}\n```\nThe function now correctly returns the sum.";
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project",
        workflow: "dev",
        task: "Fix the add function",
        reportDir: "E:/project/.codex-mimo/reports"
      },
      {
        ...baseDeps(makeMimoStdout(codeMessage)),
        captureDiff: async () => ({
          changedFiles: ["src/math.ts"],
          diffStat: " src/math.ts | 3 ++",
          diff: ""
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
      }
    );

    expect(result.status).toBe("passed");
    expect(result.error).toBeUndefined();
  });

  it("does not detect long message (>500 chars) as failure", async () => {
    const longMessage = "I analyzed the codebase thoroughly. " + "The architecture uses a modular approach with clear separation of concerns. ".repeat(10);
    expect(longMessage.length).toBeGreaterThan(500);

    const result = await runComposeWorkflow(
      {
        cwd: "E:/project",
        workflow: "dev",
        task: "Refactor module",
        reportDir: "E:/project/.codex-mimo/reports"
      },
      {
        ...baseDeps(makeMimoStdout(longMessage)),
        captureDiff: async () => ({
          changedFiles: ["src/module.ts"],
          diffStat: " src/module.ts | 5 +++",
          diff: ""
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
      }
    );

    expect(result.status).toBe("passed");
    expect(result.error).toBeUndefined();
  });
});
