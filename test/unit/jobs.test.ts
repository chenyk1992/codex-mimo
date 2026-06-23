import { describe, expect, it } from "vitest";
import {
  buildJobId,
  isActiveJobStatus,
  nowIso,
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
    expect(isActiveJobStatus("completed")).toBe(false);
    expect(isActiveJobStatus("failed")).toBe(false);
    expect(isActiveJobStatus("cancelled")).toBe(false);
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
      phase: "queued",
      pid: null,
      sessionId: null,
      parentJobId: null,
      createdAt,
      updatedAt: createdAt,
      changedFiles: [],
      verification: [],
      logFile: "E:/project/app/.codex-mimo/jobs/compose-abc.log",
      eventsFile: "E:/project/app/.codex-mimo/jobs/compose-abc.events.jsonl"
    };

    expect(record.kind).toBe("compose");
    expect(record.status).toBe("queued");
  });
});
