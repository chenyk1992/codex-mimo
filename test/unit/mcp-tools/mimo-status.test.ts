import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJobStore, updateJob } from "../../../src/core/job-store.js";
import { mimoStatus } from "../../../src/codex/tools.js";
import { enqueueDelivery, retryDelivery, claimDueDelivery } from "../../../src/notify/outbox.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-status-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("mimo_status", () => {
  it("returns status for a specific jobId", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
    updateJob(cwd, job.id, {
      status: "running", phase: "investigating", pid: 100, processIdentity: "start-100"
    });
    const result = await mimoStatus({ cwd, jobId: job.id });
    expect(result.jobId).toBe(job.id);
    expect(result.status).toBe("running");
    expect(result.phase).toBe("investigating");
  });

  it("returns execution callback and notification delivery metadata", async () => {
    const cwd = tempWorkspace();
    const target = { type: "webhook" as const, url: "https://example.test/hook", secretEnv: "HOOK_SECRET" };
    const job = createJobStore(cwd).create({
      kind: "compose", task: "Run dev", request: { privatePrompt: "DO NOT LEAK" }, notificationTarget: target
    });
    updateJob(cwd, job.id, {
      status: "completed",
      executionCallback: {
        invocationId: "compose-dev-1",
        outcome: "completed",
        sessionId: "ses_1",
        receivedAt: "2026-06-23T00:00:00.000Z"
      }
    });
    await enqueueDelivery(job.notificationOutboxFile, {
      jobId: job.id, signalCursor: 1, target, createdAt: "2026-07-16T00:00:00.000Z"
    });
    const claimed = await claimDueDelivery(job.notificationOutboxFile, new Date("2026-07-16T00:00:01.000Z"), 30_000);
    await retryDelivery(job.notificationOutboxFile, claimed!.id, claimed!.attempts, new Date("2026-07-16T00:01:00.000Z"), "busy");

    const result = await mimoStatus({ cwd, jobId: job.id });
    expect(result.executionCallback).toMatchObject({
      invocationId: "compose-dev-1",
      outcome: "completed",
      sessionId: "ses_1"
    });
    expect(result.notification).toEqual({
      targetType: "webhook", status: "pending", attempts: 1, lastError: "busy"
    });
    expect(JSON.stringify(result)).not.toContain("DO NOT LEAK");
  });

  it("defaults to most recent job when jobId is omitted", async () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job1 = store.create({ kind: "compose", task: "First", request: {} });
    const job2 = store.create({ kind: "compose", task: "Second", request: {} });
    updateJob(cwd, job2.id, { status: "completed", summary: "Done" });
    const result = await mimoStatus({ cwd });
    expect(result.jobId).toBe(job2.id);
  });

  it("throws when no jobs exist", async () => {
    const cwd = tempWorkspace();
    await expect(mimoStatus({ cwd })).rejects.toThrow("No jobs recorded");
  });
});
