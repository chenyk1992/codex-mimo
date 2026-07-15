import { describe, expect, it } from "vitest";
import {
  buildJobId,
  isActiveJobStatus,
  nowIso,
  type ExecutionCallbackSummary,
  type JobReceipt,
  type JobRecord
} from "../../src/core/jobs.js";

describe("job types", () => {
  it("builds stable job ids with a prefix and timestamp-safe suffix", () => {
    const id = buildJobId("compose", () => 1234567890, () => "abc123");
    expect(id).toBe("compose-kf12oi-abc123");
  });

  it("detects active statuses", () => {
    expect(isActiveJobStatus("queued")).toBe(true);
    expect(isActiveJobStatus("running")).toBe(true);
    expect(isActiveJobStatus("needs_input")).toBe(true);
    expect(isActiveJobStatus("blocked")).toBe(true);
    expect(isActiveJobStatus("completed")).toBe(false);
    expect(isActiveJobStatus("failed")).toBe(false);
    expect(isActiveJobStatus("cancelled")).toBe(false);
    expect(isActiveJobStatus("timeout")).toBe(false);
  });

  it("allows the canonical job record shape", () => {
    const createdAt = nowIso();
    const record: JobRecord = {
      id: "compose-abc",
      kind: "compose",
      cwd: "E:/project/app",
      task: "Run dev workflow",
      request: { workflow: "dev" },
      status: "queued",
      pid: null,
      sessionId: null,
      parentJobId: null,
      createdAt,
      updatedAt: createdAt,
      changedFiles: [],
      verification: [],
      logFile: "E:/project/app/.codex-mimo/jobs/compose-abc.log",
      eventsFile: "E:/project/app/.codex-mimo/jobs/compose-abc.events.jsonl",
      signalsFile: "E:/project/app/.codex-mimo/jobs/compose-abc.signals.jsonl",
      notificationOutboxFile: "E:/project/app/.codex-mimo/jobs/notifications.jsonl"
    };

    expect(record.kind).toBe("compose");
    expect(record.status).toBe("queued");
  });

  it("uses the unified execution callback and queued receipt contracts", () => {
    const executionCallback: ExecutionCallbackSummary = {
      invocationId: "invocation-1",
      outcome: "completed"
    };
    const receipt: JobReceipt = {
      jobId: "implement-abc",
      kind: "implement",
      status: "queued",
      actions: {
        status: "mimo_status",
        events: "mimo_events",
        result: "mimo_result",
        cancel: "mimo_cancel"
      }
    };

    expect(executionCallback.outcome).toBe("completed");
    expect(receipt.actions.events).toBe("mimo_events");
  });
});
