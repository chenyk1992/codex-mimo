import { describe, expect, it } from "vitest";
import { classifyRunOutcome, type RunEvidence } from "../../../src/core/job-outcome.js";
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
      summary: "Implementation complete.",
      sessionId: "ses-1",
      verification,
      executionCallback: completedCallback
    });
  });
});
