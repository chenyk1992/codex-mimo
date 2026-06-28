import { describe, expect, it } from "vitest";
import { buildCodexWakeHint } from "../../src/codex/wake.js";
import type { JobRecord } from "../../src/core/jobs.js";

function job(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "compose-1",
    kind: "compose",
    workflow: "dev",
    cwd: "E:/project/app",
    task: "Implement login throttling",
    request: { workflow: "dev" },
    status: "running",
    phase: "verifying",
    pid: 123,
    sessionId: null,
    parentJobId: null,
    createdAt: "2026-06-23T00:00:00.000Z",
    updatedAt: "2026-06-23T00:00:02.000Z",
    changedFiles: [],
    verification: [],
    logFile: "job.log",
    eventsFile: "job.events.jsonl",
    signalsFile: "job.signals.jsonl",
    ...patch
  };
}

describe("Codex wake hints", () => {
  it("builds a compact heartbeat-ready prompt around mimo_wait", () => {
    const hint = buildCodexWakeHint(job(), {
      sinceCursor: 7,
      minLevel: "info",
      timeoutMs: 1_800_000
    });

    expect(hint).toMatchObject({
      kind: "codex_heartbeat",
      jobId: "compose-1",
      status: "running",
      phase: "verifying",
      watch: {
        tool: "mimo_wait",
        arguments: {
          cwd: "E:/project/app",
          jobId: "compose-1",
          sinceCursor: 7,
          minLevel: "info",
          timeoutMs: 1_800_000
        }
      }
    });
    expect(hint.attentionKinds).toEqual(["needs_input", "blocked", "completed", "failed", "cancelled", "timeout"]);
    expect(hint.heartbeat).toMatchObject({
      tool: "automation_update",
      arguments: {
        mode: "create",
        kind: "heartbeat",
        destination: "thread",
        name: "MiMoCode job compose-1",
        status: "ACTIVE"
      }
    });
    expect(hint.heartbeat?.arguments.prompt).toBe(hint.prompt);
    expect(typeof hint.heartbeat?.arguments.rrule).toBe("string");
    expect(hint.prompt).toContain("mimo_wait");
    expect(hint.prompt).toContain("mimo_result");
    expect(hint.prompt).toContain("compose-1");
  });

  it("returns a result hint instead of a heartbeat draft for terminal jobs", () => {
    const hint = buildCodexWakeHint(job({ status: "completed", phase: "done" }));

    expect(hint).not.toHaveProperty("heartbeat");
    expect(hint).toMatchObject({
      kind: "codex_heartbeat",
      jobId: "compose-1",
      status: "completed",
      phase: "done",
      result: {
        tool: "mimo_result",
        arguments: {
          cwd: "E:/project/app",
          jobId: "compose-1"
        }
      }
    });
    expect(hint.prompt).toContain("already completed");
    expect(hint.prompt).toContain("mimo_result");
    expect(hint.prompt).not.toContain("create another heartbeat");
  });
});
