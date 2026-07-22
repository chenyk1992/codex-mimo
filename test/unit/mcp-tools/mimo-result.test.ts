import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJobStore, updateJob } from "../../../src/core/job-store.js";
import { mimoResult } from "../../../src/codex/tools.js";
import { enqueueDelivery, completeDelivery, claimDueDelivery, failDelivery } from "../../../src/notify/outbox.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-result-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const cwd of tempDirs.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

describe("mimo_result", () => {
  it.each(["needs_input", "blocked", "completed", "failed", "cancelled", "timeout"] as const)
    ("reads %s jobs", async (status) => {
      const cwd = tempWorkspace();
      const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
      updateJob(cwd, job.id, {
        status,
        summary: `${status} summary`,
        sessionId: status === "needs_input" || status === "blocked" ? "ses_1" : null
      });

      const result = await mimoResult({ cwd, jobId: job.id });
      expect(result.status).toBe(status);
      expect(result.resultType).toBe(status === "needs_input" || status === "blocked" ? "partial" : "final");
    });

  it.each(["queued", "running"] as const)("rejects %s jobs", async (status) => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "plan", task: "Plan", request: {} });
    if (status === "running") {
      updateJob(cwd, job.id, { status, pid: 10, processIdentity: "start-10" });
    }
    await expect(mimoResult({ cwd, jobId: job.id })).rejects.toThrow("Job result is not available");
  });

  it("returns the latest persisted notification delivery state", async () => {
    const cwd = tempWorkspace();
    const target = { type: "codex" as const, threadId: "thread-1" };
    const job = createJobStore(cwd).create({
      kind: "review", task: "Review", request: {}, notificationTarget: target
    });
    updateJob(cwd, job.id, { status: "completed", summary: "Done." });
    await enqueueDelivery(job.notificationOutboxFile, {
      jobId: job.id, signalCursor: 1, target, createdAt: "2026-07-16T00:00:00.000Z"
    });
    const claimed = await claimDueDelivery(job.notificationOutboxFile, new Date("2026-07-16T00:00:01.000Z"), 30_000);
    await completeDelivery(job.notificationOutboxFile, claimed!.id, claimed!.attempts, new Date("2026-07-16T00:00:02.000Z"));

    expect((await mimoResult({ cwd, jobId: job.id })).notification).toEqual({
      targetType: "codex", status: "delivered", attempts: 1
    });
  });


  it("forwards allowlisted notification errorCode on failed delivery", async () => {
    const cwd = tempWorkspace();
    const target = { type: "codex" as const, threadId: "thread-1" };
    const job = createJobStore(cwd).create({
      kind: "review", task: "Review", request: {}, notificationTarget: target
    });
    updateJob(cwd, job.id, { status: "completed", summary: "Done." });
    await enqueueDelivery(job.notificationOutboxFile, {
      jobId: job.id, signalCursor: 1, target, createdAt: "2026-07-16T00:00:00.000Z"
    });
    const claimed = await claimDueDelivery(job.notificationOutboxFile, new Date("2026-07-16T00:00:01.000Z"), 30_000);
    await failDelivery(
      job.notificationOutboxFile,
      claimed!.id,
      claimed!.attempts,
      "cli missing",
      "codex_cli_not_found"
    );

    expect((await mimoResult({ cwd, jobId: job.id })).notification).toEqual({
      targetType: "codex",
      status: "failed",
      attempts: 1,
      lastError: "Notification delivery requires attention.",
      errorCode: "codex_cli_not_found"
    });
  });
  it("selects the most recent readable result when jobId is omitted", async () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const finished = store.create({ kind: "plan", task: "First", request: {} });
    store.create({ kind: "plan", task: "Still running", request: {} });
    updateJob(cwd, finished.id, { status: "failed", summary: "First failed" });
    expect((await mimoResult({ cwd })).jobId).toBe(finished.id);
  });
});
