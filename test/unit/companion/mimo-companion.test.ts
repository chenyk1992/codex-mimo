import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideStopFollowup,
  emptyState,
  extractWorkReceipt,
  handleAfterMcp,
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

  it("asks for mimo_result when a watched job reaches attention", async () => {
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
    const decided = await decideStopFollowup(state, {
      now: new Date("2026-07-20T01:01:00.000Z")
    });
    expect(decided.followup).toContain("MiMo job");
    expect(decided.followup).toContain("mimo_result");
    expect(decided.followup).toContain("plan-1");
    expect(decided.followup).not.toMatch(/mimo_status|mimo_wait/);
    expect(decided.followup!.length).toBeLessThanOrEqual(400);
    expect(decided.nextState.acked[watchKey(cwd, "plan-1")]?.status).toBe("failed");
    expect(decided.nextState.watches).toHaveLength(0);
  });

  it("does not re-followup an already-acked attention status", async () => {
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
    const first = await decideStopFollowup(watched, {
      now: new Date("2026-07-20T01:01:00.000Z")
    });
    expect(first.followup).toContain("mimo_result");
    const second = await decideStopFollowup(first.nextState, {
      now: new Date("2026-07-20T01:02:00.000Z")
    });
    expect(second.followup).toBeUndefined();
    expect(second.nextState.watches).toHaveLength(0);
  });

  it("clears ack when the same job is watched again", async () => {
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
    const decided = await decideStopFollowup(rewatched, {
      now: new Date("2026-07-20T02:01:00.000Z")
    });
    expect(decided.followup).toContain("mimo_result");
  });

  it("blocks on active jobs then asks for mimo_result when completed", async () => {
    const cwd = tempDir();
    const jobFile = path.join(cwd, ".codex-mimo", "jobs", "plan-2.json");
    writeJob(cwd, {
      id: "plan-2",
      status: "running",
      startedAt: "2026-07-20T00:00:00.000Z",
      request: { timeoutMs: 1_800_000 },
      // Clock must leave job remaining > 0 (timeout ends 00:30); 01:00 would zero the budget.
      updatedAt: "2026-07-20T00:10:00.000Z"
    });
    const state = upsertWatch(emptyState(), {
      cwd, jobId: "plan-2", kind: "plan", createdAt: "2026-07-20T00:00:00.000Z"
    });
    let now = Date.parse("2026-07-20T00:10:00.000Z");
    const decided = await decideStopFollowup(state, {
      hookStatus: "completed",
      now: () => new Date(now),
      hookTimeoutMs: 1_860_000,
      sleep: async (ms) => {
        now += ms;
        fs.writeFileSync(jobFile, `${JSON.stringify({
          id: "plan-2",
          status: "completed",
          startedAt: "2026-07-20T00:00:00.000Z",
          request: { timeoutMs: 1_800_000 }
        }, null, 2)}\n`);
      }
    });
    expect(decided.followup).toContain("mimo_result");
    expect(decided.followup).not.toMatch(/mimo_status|mimo_wait/);
    expect(decided.followup!.length).toBeLessThanOrEqual(400);
  });

  it("exhausts wait budget and leaves the auto-wait queue", async () => {
    const cwd = tempDir();
    writeJob(cwd, {
      id: "plan-ex",
      status: "running",
      startedAt: "2026-07-20T00:00:00.000Z",
      request: { timeoutMs: 1_800_000 }
    });
    const state = upsertWatch(emptyState(), {
      cwd, jobId: "plan-ex", kind: "plan", createdAt: "2026-07-20T00:00:00.000Z"
    });
    let now = Date.parse("2026-07-20T00:00:00.000Z");
    const decided = await decideStopFollowup(state, {
      hookStatus: "completed",
      now: () => new Date(now),
      hookTimeoutMs: 1_860_000,
      envWaitSec: 50,
      sleep: async (ms) => { now += ms; }
    });
    expect(decided.followup).toMatch(/still running|host wait/i);
    expect(decided.followup).toContain("mimo_status");
    expect(decided.followup).not.toMatch(/mimo_wait/);
    expect(decided.nextState.watches.find((w) => w.jobId === "plan-ex")).toBeUndefined();
    expect(decided.nextState.acked[watchKey(cwd, "plan-ex")]?.status).toBe("exhausted");
  });

  it("does not follow up on aborted stops", async () => {
    const cwd = tempDir();
    writeJob(cwd, { id: "plan-3", status: "completed", updatedAt: "2026-07-20T01:00:00.000Z" });
    const state = upsertWatch(emptyState(), {
      cwd,
      jobId: "plan-3",
      kind: "plan",
      createdAt: "2026-07-20T00:00:00.000Z"
    });
    const decided = await decideStopFollowup(state, { hookStatus: "aborted" });
    expect(decided.followup).toBeUndefined();
  });
});
