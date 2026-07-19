import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendJobSignal } from "../../../src/core/job-signals.js";
import { createJobStore, updateJob } from "../../../src/core/job-store.js";
import { claimDueDelivery, enqueueDelivery, readDeliveries } from "../../../src/notify/outbox.js";
import { runNotificationWorker } from "../../../src/notify/worker.js";
import type { DeliveryAttemptResult, NotificationTarget } from "../../../src/notify/types.js";

const roots: string[] = [];
const createdAt = "2026-07-16T00:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-notify-worker-"));
  roots.push(cwd);
  return cwd;
}

async function makeDelivery(cwd: string, target: NotificationTarget) {
  const job = createJobStore(cwd).create({
    kind: "implement",
    task: "safe task",
    request: {},
    notificationTarget: target
  });
  updateJob(cwd, job.id, {
    status: "completed",
    completedAt: createdAt,
    summary: "done"
  });
  const signal = appendJobSignal(job.signalsFile, {
    jobId: job.id,
    kind: "completed",
    level: "info",
    status: "completed",
    summary: "done",
    createdAt
  });
  await enqueueDelivery(job.notificationOutboxFile, {
    jobId: job.id,
    signalCursor: signal.cursor,
    target,
    createdAt
  });
  return job;
}

describe("notification worker", () => {
  it("reclaims an expired delivery lease after worker restart", async () => {
    const cwd = makeCwd();
    const job = await makeDelivery(cwd, { type: "codex", threadId: "thread-1" });
    await claimDueDelivery(job.notificationOutboxFile, new Date(createdAt), 10_000);
    const deliver = vi.fn(async (): Promise<DeliveryAttemptResult> => ({ outcome: "delivered" }));

    await runNotificationWorker(cwd, {
      now: () => new Date("2026-07-16T00:00:11.000Z"),
      deliver,
      sleep: async () => undefined
    });

    expect(deliver.mock.calls[0][0]).toMatchObject({ attempts: 2 });
    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
      status: "delivered",
      attempts: 2
    });
  });

  it("waits until the nearest retry time and exits after all deliveries finish", async () => {
    const cwd = makeCwd();
    const job = await makeDelivery(cwd, { type: "codex", threadId: "thread-1" });
    let nowMs = Date.parse(createdAt);
    const deliver = vi.fn()
      .mockResolvedValueOnce({ outcome: "retry", error: "busy" })
      .mockResolvedValueOnce({ outcome: "delivered" });
    const sleep = vi.fn(async (delayMs: number) => { nowMs += delayMs; });

    await runNotificationWorker(cwd, {
      now: () => new Date(nowMs),
      deliver,
      sleep
    });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(10_000);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
      status: "delivered",
      attempts: 2
    });
  });

  it("never persists a webhook secret value in job, log, or outbox files", async () => {
    const cwd = makeCwd();
    const secret = "actual-super-secret-value";
    const job = await makeDelivery(cwd, {
      type: "webhook",
      url: "https://example.test/hook",
      secretEnv: "TASK6_WEBHOOK_SECRET"
    });
    fs.writeFileSync(job.logFile, "notification worker started\n", "utf8");
    const fetch = vi.fn(async () => ({ status: 204 } as Response));

    await runNotificationWorker(cwd, {
      now: () => new Date(createdAt),
      env: { TASK6_WEBHOOK_SECRET: secret },
      fetch,
      sleep: async () => undefined
    });

    const persisted = [job.logFile, job.notificationOutboxFile, path.join(cwd, ".codex-mimo", "jobs", `${job.id}.json`)]
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    expect(persisted).not.toContain(secret);
    expect(readDeliveries(job.notificationOutboxFile)[0].status).toBe("delivered");
  });
});
