import { describe, expect, it } from "vitest";
import {
  classifyRunOutcome,
  detectUnacceptedTask,
  type RunEvidence
} from "../../../src/core/job-outcome.js";
import type { ExecutionCallbackSummary } from "../../../src/core/jobs.js";

const completedCallback: ExecutionCallbackSummary = {
  invocationId: "inv-1",
  outcome: "completed",
  sessionId: "ses-1"
};

function evidence(patch: Partial<RunEvidence> = {}): RunEvidence {
  return {
    exitCode: 0,
    executionCallback: completedCallback,
    verification: [{ command: "npm test", exitCode: 0, passed: true }],
    finalText: "Implementation complete.",
    ...patch
  };
}

describe("run outcome classification", () => {
  it("treats an absent execution callback as callback_missing", () => {
    expect(classifyRunOutcome(evidence({ executionCallback: undefined }))).toMatchObject({
      status: "failed",
      errorCode: "callback_missing"
    });
  });

  it("gives user cancellation highest precedence", () => {
    const outcome = classifyRunOutcome(evidence({
      terminationReason: "user_cancelled",
      executionCallback: { ...completedCallback, outcome: "error" },
      verification: [{ command: "npm test", exitCode: 1, passed: false }],
      finalText: "I need your input. Blocked: missing permission.",
      exitCode: 1
    }));

    expect(outcome).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
  });

  it("gives timeout precedence over callback and text failures", () => {
    const outcome = classifyRunOutcome(evidence({
      terminationReason: "process_timeout",
      executionCallback: { ...completedCallback, outcome: "error" },
      finalText: "Please provide the credentials.",
      exitCode: 124
    }));

    expect(outcome).toMatchObject({ status: "timeout", errorCode: "timeout" });
  });

  it("maps progress_timeout to stalled without colliding with idle_timeout", () => {
    expect(classifyRunOutcome({
      exitCode: 124,
      terminationReason: "progress_timeout",
      verification: [],
      finalText: "",
      stallErrorCode: "command_silent"
    })).toMatchObject({
      status: "stalled",
      errorCode: "command_silent"
    });

    expect(classifyRunOutcome({
      exitCode: 124,
      terminationReason: "idle_timeout",
      verification: [],
      finalText: ""
    })).toMatchObject({
      status: "timeout",
      errorCode: "idle_timeout"
    });
  });

  it("maps idle_timeout termination to a distinct timeout outcome", () => {
    expect(classifyRunOutcome({
      exitCode: 124,
      terminationReason: "idle_timeout",
      verification: [],
      finalText: ""
    })).toMatchObject({
      status: "timeout",
      errorCode: "idle_timeout",
      summary: "MiMoCode job idle-timed out.",
      error: "MiMoCode job idle-timed out."
    });
  });

  it("keeps process_timeout on absolute timeout", () => {
    expect(classifyRunOutcome({
      exitCode: 124,
      terminationReason: "process_timeout",
      verification: [],
      finalText: ""
    }).errorCode).toBe("timeout");
  });

  it("does not mistake a host abort exit code for a process timeout", () => {
    expect(classifyRunOutcome(evidence({
      terminationReason: "host_abort",
      exitCode: 124
    }))).toMatchObject({ status: "failed", errorCode: "mimo_exit_nonzero" });
  });

  it.each([
    ["missing", "callback_missing"],
    ["error", "callback_error"],
    ["cancelled", "callback_cancelled"]
  ] as const)("maps %s callback before final text and process failure", (callbackOutcome, errorCode) => {
    const outcome = classifyRunOutcome(evidence({
      executionCallback: {
        ...completedCallback,
        outcome: callbackOutcome,
        error: "callback problem"
      },
      finalText: "Please clarify which database to use.",
      exitCode: 1
    }));

    expect(outcome).toMatchObject({ status: "failed", errorCode });
  });

  it.each([
    "I need your input before I can finish.",
    "I need additional user input before I can finish.",
    "Please provide the deployment region.",
    "Please clarify which database to use.",
    "Which database should I use?"
  ])("recognizes an explicit input request: %s", (finalText) => {
    expect(classifyRunOutcome(evidence({
      finalText,
      verification: [{ command: "npm test", exitCode: 1, passed: false }],
      exitCode: 1
    }))).toMatchObject({ status: "needs_input" });
  });

  it("gives needs-input text precedence over blocker text", () => {
    expect(classifyRunOutcome(evidence({
      finalText: "Blocked by missing permission.\nPlease provide access to the repository."
    }))).toMatchObject({ status: "needs_input" });
  });

  it.each([
    "Blocked: the required service is unavailable.",
    "I cannot continue without repository permission.",
    "Missing dependency: the compiler is not installed.",
    "Missing required permission to access the repository.",
    "External service unavailable: package registry."
  ])("recognizes an explicit blocker: %s", (finalText) => {
    expect(classifyRunOutcome(evidence({ finalText, exitCode: 1 })))
      .toMatchObject({ status: "blocked" });
  });

  it.each([
    "Why does this race condition happen?",
    "Could this code use a smaller abstraction?",
    "What happens when the queue is empty?"
  ])("does not treat an ordinary reasoning question as needs-input: %s", (finalText) => {
    expect(classifyRunOutcome(evidence({ finalText }))).toMatchObject({ status: "completed" });
  });

  it.each([
    "Which database should I use?\n\nImplementation completed successfully.",
    "Blocked: the registry was temporarily unavailable.\n\nImplementation completed successfully."
  ])("uses only the final meaningful paragraph: %s", (finalText) => {
    expect(classifyRunOutcome(evidence({ finalText }))).toMatchObject({ status: "completed" });
  });

  it.each([
    "Hello! What would you like me to help with?",
    "Hi, please share your task.",
    "Hey, what can I help you with?",
    "hELLo, Please share your task."
  ])("normalizes one standalone greeting prefix before semantic matching: %s", (finalText) => {
    expect(detectUnacceptedTask(finalText)).toBe("MiMoCode did not receive or accept the task objective.");
  });

  it.each([
    "Hello world implementation completed successfully.",
    "Hi, the requested change is complete.",
    "Hey, implementation is done.",
    "highlight implementation completed successfully."
  ])("does not turn an ordinary completion into a missing-task response: %s", (finalText) => {
    expect(detectUnacceptedTask(finalText)).toBeUndefined();
  });

  it("gives failed verification precedence over a nonzero exit", () => {
    expect(classifyRunOutcome(evidence({
      exitCode: 2,
      verification: [{ command: "npm test", exitCode: 1, passed: false }]
    }))).toMatchObject({ status: "failed", errorCode: "verification_failed" });
  });

  it("classifies a nonzero process exit", () => {
    expect(classifyRunOutcome(evidence({ exitCode: 2 })))
      .toMatchObject({ status: "failed", errorCode: "mimo_exit_nonzero" });
  });

  it("returns completion metadata", () => {
    const verification = [{ command: "npm test", exitCode: 0, passed: true }];
    expect(classifyRunOutcome(evidence({ verification }))).toEqual({
      status: "completed",
      summary: "MiMoCode completed the job.",
      sessionId: "ses-1",
      verification,
      executionCallback: completedCallback
    });
  });

  it("fails with result_missing when final text is required and empty", () => {
    expect(classifyRunOutcome(evidence({
      finalText: "",
      requireFinalText: true
    }))).toEqual({
      status: "failed",
      summary: "MiMoCode did not return a final result.",
      sessionId: "ses-1",
      verification: [{ command: "npm test", exitCode: 0, passed: true }],
      executionCallback: completedCallback,
      error: "MiMoCode did not return a final result.",
      errorCode: "result_missing"
    });
  });

  it("fails with result_missing for whitespace-only final text when required", () => {
    expect(classifyRunOutcome(evidence({
      finalText: "   \n\t  ",
      requireFinalText: true
    }))).toMatchObject({
      status: "failed",
      errorCode: "result_missing",
      summary: "MiMoCode did not return a final result.",
      error: "MiMoCode did not return a final result."
    });
  });

  it("completes when required final text is non-empty", () => {
    expect(classifyRunOutcome(evidence({
      finalText: "# Plan\n\nDo the work.",
      requireFinalText: true
    }))).toMatchObject({ status: "completed" });
  });

  it("preserves completion for empty final text when requireFinalText is omitted or false", () => {
    expect(classifyRunOutcome(evidence({ finalText: "" }))).toMatchObject({ status: "completed" });
    expect(classifyRunOutcome(evidence({
      finalText: "",
      requireFinalText: false
    }))).toMatchObject({ status: "completed" });
  });

  it.each([
    [{ terminationReason: "user_cancelled" as const }, "cancelled"],
    [{ terminationReason: "process_timeout" as const }, "timeout"],
    [{
      executionCallback: {
        invocationId: "inv-1",
        outcome: "missing" as const
      }
    }, "callback_missing"],
    [{ verification: [{ command: "npm test", exitCode: 1, passed: false }] }, "verification_failed"]
  ])("keeps higher-precedence failures over result_missing: %j", (patch, errorCode) => {
    expect(classifyRunOutcome(evidence({
      finalText: "",
      requireFinalText: true,
      ...patch
    })).errorCode).toBe(errorCode);
  });

  it.each([
    ["completed", "Implementation complete.\n" + "PROMPT_ECHO_SECRET ".repeat(200)],
    ["needs_input", "Please provide PROMPT_ECHO_SECRET before continuing."],
    ["blocked", "Blocked: PROMPT_ECHO_SECRET external service unavailable."]
  ] as const)("never exposes arbitrary final text in a %s public outcome", (status, finalText) => {
    const outcome = classifyRunOutcome(evidence({ finalText }));

    expect(outcome.status).toBe(status);
    expect(outcome.summary).not.toContain("PROMPT_ECHO_SECRET");
    expect(outcome.summary).not.toMatch(/[\r\n]/);
    expect(outcome.summary.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(outcome)).not.toContain("PROMPT_ECHO_SECRET");
  });
});
