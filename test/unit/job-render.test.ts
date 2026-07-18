import { describe, expect, it } from "vitest";
import { renderJobResult, renderJobStatus } from "../../src/core/job-render.js";
import type { JobRecord } from "../../src/core/jobs.js";

function job(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "implement-1",
    kind: "implement",
    cwd: "E:/project/app",
    task: "Implement login throttling",
    request: { cwd: "E:/project/app", task: "Implement login throttling", allowWrite: true },
    status: "running",
    phase: "verifying",
    pid: 123,
    processIdentity: "win32:123",
    sessionId: "ses_123",
    parentJobId: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    startedAt: "2026-07-16T00:00:01.000Z",
    updatedAt: "2026-07-16T00:00:02.000Z",
    changedFiles: ["src/login.ts"],
    verification: [],
    summary: "Running npm test.",
    notificationTarget: { type: "codex", threadId: "thread-1" },
    logFile: "PRIVATE PROMPT job.log",
    eventsFile: "PRIVATE RAW events.jsonl",
    signalsFile: "PRIVATE SIGNALS signals.jsonl",
    notificationOutboxFile: "PRIVATE OUTBOX notifications.jsonl",
    ...patch
  };
}

describe("compact job rendering", () => {
  it("renders compact running status with only valid actions", () => {
    const result = renderJobStatus(job(), {
      nowMs: Date.parse("2026-07-16T00:00:11.000Z"),
      progress: ["Verification started."],
      notification: { targetType: "codex", status: "delivering", attempts: 2, lastError: "busy" }
    });

    expect(result).toMatchObject({
      jobId: "implement-1",
      kind: "implement",
      parentJobId: null,
      status: "running",
      phase: "verifying",
      elapsedMs: 10_000,
      sessionId: "ses_123",
      summary: "MiMoCode entered the verifying phase.",
      changedFiles: ["src/login.ts"],
      progress: ["MiMoCode entered the verifying phase."],
      notification: {
        targetType: "codex",
        status: "delivering",
        attempts: 2,
        lastError: "Notification delivery requires attention."
      },
      actions: {
        events: "mimo_events",
        wait: "mimo_wait",
        cancel: "mimo_cancel"
      }
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|request|prompt|eventsFile|signalsFile|logFile|outbox/i);
  });

  it.each([
    ["needs_input", { result: "mimo_result", events: "mimo_events", resume: "mimo_resume" }],
    ["blocked", { result: "mimo_result", events: "mimo_events", resume: "mimo_resume" }],
    ["completed", { result: "mimo_result", events: "mimo_events" }],
    ["failed", { result: "mimo_result", events: "mimo_events" }],
    ["cancelled", { result: "mimo_result", events: "mimo_events" }],
    ["timeout", { result: "mimo_result", events: "mimo_events" }]
  ] as const)("renders only valid %s status actions", (status, actions) => {
    expect(renderJobStatus(job({ status, phase: undefined })).actions).toEqual(actions);
  });

  it.each(["needs_input", "blocked"] as const)("renders %s as a partial result with resume", (status) => {
    const result = renderJobResult(job({
      status,
      phase: undefined,
      executionCallback: {
        invocationId: "inv-1",
        outcome: "completed",
        sessionId: "ses_123",
        receivedAt: "2026-07-16T00:00:03.000Z"
      },
      verification: [{ command: "npm test", exitCode: 1, passed: false, durationMs: 42 }],
      reportPaths: { json: "report.json", markdown: "report.md", diff: "report.diff" },
      error: status === "needs_input"
        ? "MiMoCode needs additional input."
        : "MiMoCode is blocked by an external condition.",
      errorCode: "needs_input"
    }), { targetType: "codex", status: "delivered", attempts: 1 });

    expect(result).toMatchObject({
      resultType: "partial",
      executionCallback: { invocationId: "inv-1", outcome: "completed" },
      verification: [{ command: "npm test", exitCode: 1, passed: false, durationMs: 42 }],
      reportPaths: { json: "report.json", markdown: "report.md", diff: "report.diff" },
      error: status === "needs_input"
        ? "MiMoCode needs additional input."
        : "MiMoCode is blocked by an external condition.",
      errorCode: "needs_input",
      notification: { targetType: "codex", status: "delivered", attempts: 1 },
      actions: { status: "mimo_status", events: "mimo_events", resume: "mimo_resume" }
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|request|prompt|stdout|stderr|raw/i);
  });

  it.each(["completed", "failed", "cancelled", "timeout"] as const)
    ("renders %s as a final result without resume", (status) => {
      const result = renderJobResult(job({ status, phase: undefined }));
      expect(result.resultType).toBe("final");
      expect(result.actions).toEqual({ status: "mimo_status", events: "mimo_events" });
    });
});
