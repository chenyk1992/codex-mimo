import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendJobSignal } from "../../../src/core/job-signals.js";
import { createJobStore, readJob, updateJob } from "../../../src/core/job-store.js";
import {
  dispatchNextDelivery,
  retryDelayMs,
  summarizeJobNotification
} from "../../../src/notify/dispatcher.js";
import { enqueueDelivery, readDeliveries } from "../../../src/notify/outbox.js";
import type { DeliveryAttemptResult, NotificationDelivery } from "../../../src/notify/types.js";

const roots: string[] = [];
const createdAt = "2026-07-16T00:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-dispatcher-"));
  roots.push(cwd);
  return cwd;
}

async function makeDelivery(
  cwd: string,
  target: NotificationDelivery["target"] = { type: "codex", threadId: "thread-1" }
) {
  const job = createJobStore(cwd).create({
    kind: "implement",
    task: "implement safely",
    request: {},
    notificationTarget: target
  });
  updateJob(cwd, job.id, {
    status: "completed",
    completedAt: createdAt,
    summary: "Implementation completed."
  });
  const signal = appendJobSignal(job.signalsFile, {
    jobId: job.id,
    kind: "completed",
    level: "info",
    status: "completed",
    summary: "Implementation completed.",
    createdAt
  });
  const { delivery } = await enqueueDelivery(job.notificationOutboxFile, {
    jobId: job.id,
    signalCursor: signal.cursor,
    target,
    createdAt
  });
  return { job: readJob(cwd, job.id)!, signal, delivery };
}

describe("notification dispatcher", () => {
  it.each([
    [1, 10_000],
    [2, 60_000],
    [3, 300_000],
    [4, 300_000],
    [9, 300_000]
  ])("uses fixed delay for attempt %s", (attempt, delay) => {
    expect(retryDelayMs(attempt)).toBe(delay);
  });

  it("uses the current claim generation when completing a delivery", async () => {
    const cwd = makeCwd();
    const { job } = await makeDelivery(cwd);
    const deliver = vi.fn(async (): Promise<DeliveryAttemptResult> => ({ outcome: "delivered" }));

    await dispatchNextDelivery(cwd, {
      now: () => new Date(createdAt),
      leaseMs: 30_000,
      deliver
    });

    expect(deliver.mock.calls[0][0]).toMatchObject({ status: "delivering", attempts: 1 });
    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
      status: "delivered",
      attempts: 1,
      deliveredAt: createdAt
    });
  });

  it("schedules attempt one failure ten seconds later", async () => {
    const cwd = makeCwd();
    const { job } = await makeDelivery(cwd);

    await dispatchNextDelivery(cwd, {
      now: () => new Date(createdAt),
      deliver: async () => ({ outcome: "retry", error: "offline" })
    });

    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      nextAttemptAt: "2026-07-16T00:00:10.000Z",
      lastError: "offline"
    });
  });

  it("marks delivery failed after thirty minutes without changing the job", async () => {
    const cwd = makeCwd();
    const { job } = await makeDelivery(cwd);
    const before = readJob(cwd, job.id)!;

    await dispatchNextDelivery(cwd, {
      now: () => new Date("2026-07-16T00:31:00.000Z"),
      deliver: async () => ({ outcome: "retry", error: "offline" })
    });

    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "offline"
    });
    expect(readJob(cwd, job.id)!.status).toBe(before.status);
    expect(readJob(cwd, job.id)!.updatedAt).toBe(before.updatedAt);
  });

  it("routes only by the frozen target type and creates and closes a Codex client per attempt", async () => {
    const cwd = makeCwd();
    await makeDelivery(cwd, { type: "codex", threadId: "thread-1" });
    await makeDelivery(cwd, { type: "codex", threadId: "thread-2" });
    const close = vi.fn(async () => undefined);
    const createCodexClient = vi.fn(() => ({
      initialize: vi.fn(async () => undefined),
      resumeThread: vi.fn(async () => ({ exists: true, busy: false })),
      startTurn: vi.fn(async () => undefined),
      close
    }));
    const deliverWebhook = vi.fn();

    await dispatchNextDelivery(cwd, { now: () => new Date(createdAt), createCodexClient, deliverWebhook });
    await dispatchNextDelivery(cwd, { now: () => new Date(createdAt), createCodexClient, deliverWebhook });

    expect(createCodexClient).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(deliverWebhook).not.toHaveBeenCalled();
  });

  it("fails safely when the signal does not match the delivery cursor", async () => {
    const cwd = makeCwd();
    const { job } = await makeDelivery(cwd);
    fs.writeFileSync(job.signalsFile, "{\"secret\":\"do-not-leak\"}\n", "utf8");

    await dispatchNextDelivery(cwd, { now: () => new Date(createdAt) });

    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
      status: "failed",
      lastError: "Notification signal data is unavailable"
    });
    expect(fs.readFileSync(job.notificationOutboxFile, "utf8")).not.toContain("do-not-leak");
  });

  it("summarizes only the latest delivery's public status fields", async () => {
    const cwd = makeCwd();
    const { job, delivery } = await makeDelivery(cwd, {
      type: "webhook",
      url: "https://private.example/hook",
      secretEnv: "PRIVATE_SECRET"
    });
    const latest: NotificationDelivery = {
      ...delivery,
      id: `${job.id}:2:webhook`,
      eventId: `${job.id}:2:webhook`,
      signalCursor: 2,
      status: "failed",
      attempts: 3,
      lastError: "Webhook request failed"
    };

    const summary = summarizeJobNotification(job, [delivery, latest]);

    expect(summary).toEqual({
      type: "webhook",
      status: "failed",
      attempts: 3,
      lastError: "Webhook request failed"
    });
    expect(JSON.stringify(summary)).not.toContain("private.example");
    expect(JSON.stringify(summary)).not.toContain("PRIVATE_SECRET");
  });
});
