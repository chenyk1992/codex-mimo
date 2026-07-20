import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideStopFollowup,
  emptyState,
  extractWorkReceipt,
  handleAfterMcp,
  handleStop,
  normalizeToolName,
  upsertWatch,
  watchKey
} from "../../../src/companion/watch.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-companion-"));
  tempRoots.push(root);
  return root;
}

function writeJob(cwd: string, job: Record<string, unknown>): void {
  const dir = path.join(cwd, ".codex-mimo", "jobs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${String(job.id)}.json`), `${JSON.stringify(job, null, 2)}\n`, "utf8");
}

describe("mimo companion helpers", () => {
  it("normalizes MCP-prefixed tool names", () => {
    expect(normalizeToolName("MCP: mimo_plan")).toBe("mimo_plan");
    expect(normalizeToolName("codex-mimocode/mimo_implement")).toBe("mimo_implement");
  });

  it("extracts receipts from string, object, and one-level wrapped payloads", () => {
    expect(
      extractWorkReceipt(
        "mimo_plan",
        JSON.stringify({ cwd: "E:/repo", task: "x" }),
        JSON.stringify({ jobId: "plan-1", kind: "plan", status: "queued" })
      )
    ).toEqual({ cwd: "E:/repo", jobId: "plan-1", kind: "plan" });

    expect(
      extractWorkReceipt(
        "mimo_plan",
        { cwd: "E:/repo", task: "x" },
        { jobId: "plan-obj", kind: "plan", status: "queued" }
      )
    ).toEqual({ cwd: "E:/repo", jobId: "plan-obj", kind: "plan" });

    expect(
      extractWorkReceipt(
        "mimo_implement",
        { cwd: "E:/repo", task: "x", allowWrite: true },
        { result: { jobId: "impl-1", kind: "implement", status: "queued" } }
      )
    ).toEqual({ cwd: "E:/repo", jobId: "impl-1", kind: "implement" });

    expect(
      extractWorkReceipt(
        "mimo_plan",
        { cwd: "E:/repo", task: "x" },
        { data: JSON.stringify({ jobId: "plan-nested", kind: "plan" }) }
      )
    ).toEqual({ cwd: "E:/repo", jobId: "plan-nested", kind: "plan" });
  });

  it("registers watches from after-mcp handling", () => {
    const result = handleAfterMcp(
      {
        tool_name: "MCP: mimo_plan",
        tool_input: JSON.stringify({ cwd: "E:/repo", task: "x" }),
        result_json: JSON.stringify({ jobId: "plan-1", kind: "plan", status: "queued" }),
        conversation_id: "conv-1"
      },
      emptyState(),
      new Date("2026-07-20T00:00:00.000Z")
    );
    expect(result.nextState.watches).toHaveLength(1);
    expect(result.nextState.watches[0]).toMatchObject({
      jobId: "plan-1",
      conversationId: "conv-1"
    });
  });

  it("asks for mimo_result when a watched job reaches attention", () => {
    const cwd = tempDir();
    writeJob(cwd, {
      id: "plan-1",
      status: "failed",
      updatedAt: "2026-07-20T01:00:00.000Z",
      errorCode: "prompt_setup_failed"
    });
    const state = upsertWatch(emptyState(), {
      cwd,
      jobId: "plan-1",
      kind: "plan",
      createdAt: "2026-07-20T00:00:00.000Z"
    });
    const decided = decideStopFollowup(state, {
      loopCount: 0,
      now: new Date("2026-07-20T01:01:00.000Z")
    });
    expect(decided.followup).toContain("mimo_result");
    expect(decided.followup).toContain("plan-1");
    expect(decided.nextState.acked[watchKey(cwd, "plan-1")]?.status).toBe("failed");
    expect(decided.nextState.watches).toHaveLength(0);
  });

  it("does not re-followup an already-acked attention status", () => {
    const cwd = tempDir();
    writeJob(cwd, {
      id: "plan-4",
      status: "completed",
      updatedAt: "2026-07-20T01:00:00.000Z"
    });
    const watched = upsertWatch(emptyState(), {
      cwd,
      jobId: "plan-4",
      kind: "plan",
      createdAt: "2026-07-20T00:00:00.000Z"
    });
    const first = decideStopFollowup(watched, {
      loopCount: 0,
      now: new Date("2026-07-20T01:01:00.000Z")
    });
    expect(first.followup).toContain("mimo_result");
    const second = decideStopFollowup(first.nextState, {
      loopCount: 1,
      now: new Date("2026-07-20T01:02:00.000Z")
    });
    expect(second.followup).toBeUndefined();
    expect(second.nextState.watches).toHaveLength(0);
  });

  it("clears ack when the same job is watched again", () => {
    const cwd = tempDir();
    writeJob(cwd, {
      id: "plan-re",
      status: "completed",
      updatedAt: "2026-07-20T01:00:00.000Z"
    });
    const key = watchKey(cwd, "plan-re");
    const ackedState: ReturnType<typeof emptyState> = {
      version: 1,
      watches: [],
      acked: { [key]: { status: "completed", ackedAt: "2026-07-20T01:01:00.000Z" } }
    };
    const rewatched = upsertWatch(ackedState, {
      cwd,
      jobId: "plan-re",
      kind: "plan",
      createdAt: "2026-07-20T02:00:00.000Z"
    });
    expect(rewatched.acked[key]).toBeUndefined();
    const decided = decideStopFollowup(rewatched, {
      loopCount: 0,
      now: new Date("2026-07-20T02:01:00.000Z")
    });
    expect(decided.followup).toContain("mimo_result");
  });

  it("polls active jobs until loop limit", () => {
    const cwd = tempDir();
    writeJob(cwd, {
      id: "plan-2",
      status: "running",
      updatedAt: "2026-07-20T01:00:00.000Z"
    });
    const state = upsertWatch(emptyState(), {
      cwd,
      jobId: "plan-2",
      kind: "plan",
      createdAt: "2026-07-20T00:00:00.000Z"
    });
    const active = handleStop({ status: "completed", loop_count: 0 }, state);
    expect(active.output.followup_message).toContain("mimo_status");
    const done = handleStop({ status: "completed", loop_count: 99 }, active.nextState, {
      maxActiveLoops: 8
    });
    expect(done.output.followup_message).toBeUndefined();
  });

  it("does not follow up on aborted stops", () => {
    const cwd = tempDir();
    writeJob(cwd, { id: "plan-3", status: "completed", updatedAt: "2026-07-20T01:00:00.000Z" });
    const state = upsertWatch(emptyState(), {
      cwd,
      jobId: "plan-3",
      kind: "plan",
      createdAt: "2026-07-20T00:00:00.000Z"
    });
    const decided = decideStopFollowup(state, { hookStatus: "aborted", loopCount: 0 });
    expect(decided.followup).toBeUndefined();
  });
});
