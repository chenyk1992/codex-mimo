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
import {
  claimDueDelivery,
  enqueueDelivery,
  readDeliveries,
  renewDeliveryLease
} from "../../../src/notify/outbox.js";
import {
  StaleDeliveryGenerationError,
  type DeliveryAttemptResult,
  type NotificationDelivery
} from "../../../src/notify/types.js";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function manualLeaseTimers() {
  interface Timer {
    active: boolean;
    callback: () => Promise<void>;
    delayMs: number;
  }
  const timers: Timer[] = [];
  const scheduleLeaseRenewal = vi.fn((callback: () => Promise<void>, delayMs: number) => {
    const timer = { active: true, callback, delayMs };
    timers.push(timer);
    return timer;
  });
  const cancelLeaseRenewal = vi.fn((timer: Timer) => { timer.active = false; });
  const fireNext = (): Promise<void> => {
    const timer = timers.find((candidate) => candidate.active);
    if (!timer) throw new Error("No active lease timer");
    timer.active = false;
    return timer.callback();
  };
  return { timers, scheduleLeaseRenewal, cancelLeaseRenewal, fireNext };
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

  it("uses adapter settlement time for retry delay", async () => {
    const cwd = makeCwd();
    const { job } = await makeDelivery(cwd);
    const times = [createdAt, "2026-07-16T00:00:05.000Z"];

    await dispatchNextDelivery(cwd, {
      now: () => new Date(times.shift()!),
      deliver: async () => ({ outcome: "retry", error: "offline" })
    });

    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
      status: "pending",
      nextAttemptAt: "2026-07-16T00:00:15.000Z"
    });
  });

  it("records deliveredAt from fresh adapter settlement time", async () => {
    const cwd = makeCwd();
    const { job } = await makeDelivery(cwd);
    const times = [createdAt, "2026-07-16T00:00:05.000Z"];

    await dispatchNextDelivery(cwd, {
      now: () => new Date(times.shift()!),
      deliver: async () => ({ outcome: "delivered" })
    });

    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
      status: "delivered",
      deliveredAt: "2026-07-16T00:00:05.000Z"
    });
  });

  it.each([
    "2026-07-16T00:30:00.000Z",
    "2026-07-16T00:30:01.000Z"
  ])("fails a retry that settles at or after the thirty-minute cutoff (%s)", async (settledAt) => {
    const cwd = makeCwd();
    const { job } = await makeDelivery(cwd);
    const times = [
      "2026-07-16T00:29:59.000Z",
      settledAt
    ];

    await dispatchNextDelivery(cwd, {
      now: () => new Date(times.shift()!),
      deliver: async () => ({ outcome: "retry", error: "offline" })
    });

    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
      status: "failed",
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

  it("renews a deferred adapter lease so a second worker cannot duplicate delivery", async () => {
    const cwd = makeCwd();
    const { job } = await makeDelivery(cwd);
    const adapter = deferred<DeliveryAttemptResult>();
    const timers = manualLeaseTimers();
    let nowMs = Date.parse(createdAt);
    const firstDeliver = vi.fn(() => adapter.promise);
    const secondDeliver = vi.fn(async (): Promise<DeliveryAttemptResult> => ({
      outcome: "delivered"
    }));

    const firstDispatch = dispatchNextDelivery(cwd, {
      now: () => new Date(nowMs),
      leaseMs: 30_000,
      deliver: firstDeliver,
      scheduleLeaseRenewal: timers.scheduleLeaseRenewal,
      cancelLeaseRenewal: timers.cancelLeaseRenewal
    });
    await vi.waitFor(() => expect(firstDeliver).toHaveBeenCalledOnce());

    for (const elapsed of [10_000, 20_000, 30_000]) {
      nowMs = Date.parse(createdAt) + elapsed;
      await timers.fireNext();
    }
    nowMs = Date.parse(createdAt) + 31_000;
    const secondResult = await dispatchNextDelivery(cwd, {
      now: () => new Date(nowMs),
      leaseMs: 30_000,
      deliver: secondDeliver
    });

    expect(secondResult).toMatchObject({ outcome: "idle" });
    expect(secondDeliver).not.toHaveBeenCalled();
    adapter.resolve({ outcome: "delivered" });
    await expect(firstDispatch).resolves.toMatchObject({ outcome: "settled" });
    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
      status: "delivered",
      attempts: 1,
      deliveredAt: "2026-07-16T00:00:31.000Z"
    });
    expect(timers.timers.every((timer) => !timer.active)).toBe(true);
  });

  it("returns a stale outcome without overwriting a reclaimed generation", async () => {
    const cwd = makeCwd();
    const { job } = await makeDelivery(cwd);
    let nowMs = Date.parse(createdAt);

    const result = await dispatchNextDelivery(cwd, {
      now: () => new Date(nowMs),
      leaseMs: 30_000,
      deliver: async () => {
        nowMs += 31_000;
        await claimDueDelivery(job.notificationOutboxFile, new Date(nowMs), 30_000);
        return { outcome: "delivered" };
      }
    });

    expect(result).toMatchObject({ outcome: "stale" });
    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
      status: "delivering",
      attempts: 2
    });
  });

  it("returns stale when a delayed heartbeat discovers that its generation was reclaimed", async () => {
    const cwd = makeCwd();
    const { job } = await makeDelivery(cwd);
    const adapter = deferred<DeliveryAttemptResult>();
    const timers = manualLeaseTimers();
    let nowMs = Date.parse(createdAt);
    const renewAfterReclaim: typeof renewDeliveryLease = async (
      file,
      id,
      attempt,
      renewalTime,
      leaseMs
    ) => {
      await claimDueDelivery(file, renewalTime, leaseMs);
      return renewDeliveryLease(file, id, attempt, renewalTime, leaseMs);
    };

    const dispatch = dispatchNextDelivery(cwd, {
      now: () => new Date(nowMs),
      leaseMs: 30_000,
      deliver: () => adapter.promise,
      renewDeliveryLease: renewAfterReclaim,
      scheduleLeaseRenewal: timers.scheduleLeaseRenewal,
      cancelLeaseRenewal: timers.cancelLeaseRenewal
    });
    await vi.waitFor(() => expect(timers.scheduleLeaseRenewal).toHaveBeenCalledOnce());
    nowMs += 31_000;
    await timers.fireNext();
    adapter.resolve({ outcome: "delivered" });

    await expect(dispatch).resolves.toMatchObject({ outcome: "stale" });
    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
      status: "delivering",
      attempts: 2
    });
  });

  it("stops heartbeat and awaits in-flight renewal before safely settling adapter errors", async () => {
    const cwd = makeCwd();
    const { job } = await makeDelivery(cwd);
    const adapter = deferred<DeliveryAttemptResult>();
    const renewal = deferred<NotificationDelivery>();
    const timers = manualLeaseTimers();
    let settled = false;
    const renewDeliveryLease = vi.fn(() => renewal.promise);

    const dispatch = dispatchNextDelivery(cwd, {
      now: () => new Date(createdAt),
      deliver: () => adapter.promise,
      renewDeliveryLease,
      scheduleLeaseRenewal: timers.scheduleLeaseRenewal,
      cancelLeaseRenewal: timers.cancelLeaseRenewal
    });
    void dispatch.then(() => { settled = true; });
    await vi.waitFor(() => expect(timers.scheduleLeaseRenewal).toHaveBeenCalledOnce());
    const tick = timers.fireNext();
    await vi.waitFor(() => expect(renewDeliveryLease).toHaveBeenCalledOnce());

    adapter.reject(new Error("adapter leaked actual-super-secret-value"));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(timers.scheduleLeaseRenewal).toHaveBeenCalledOnce();

    renewal.resolve(readDeliveries(job.notificationOutboxFile)[0]);
    await tick;
    await expect(dispatch).resolves.toMatchObject({ outcome: "settled" });
    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
      status: "pending",
      lastError: "Notification delivery failed"
    });
    expect(fs.readFileSync(job.notificationOutboxFile, "utf8"))
      .not.toContain("actual-super-secret-value");
    expect(timers.timers.every((timer) => !timer.active)).toBe(true);
  });

  it("settles a delivered adapter result after an ordinary lease-renewal failure", async () => {
    const cwd = makeCwd();
    const { job } = await makeDelivery(cwd);
    const adapter = deferred<DeliveryAttemptResult>();
    const timers = manualLeaseTimers();
    const renewDeliveryLease = vi.fn(async () => {
      throw new Error("disk failed with actual-super-secret-value");
    });

    const dispatch = dispatchNextDelivery(cwd, {
      now: () => new Date(createdAt),
      deliver: () => adapter.promise,
      renewDeliveryLease,
      scheduleLeaseRenewal: timers.scheduleLeaseRenewal,
      cancelLeaseRenewal: timers.cancelLeaseRenewal
    });
    await vi.waitFor(() => expect(timers.scheduleLeaseRenewal).toHaveBeenCalledOnce());
    await timers.fireNext();
    adapter.resolve({ outcome: "delivered" });

    await expect(dispatch).resolves.toMatchObject({ outcome: "settled" });
    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
      status: "delivered",
      attempts: 1,
      deliveredAt: createdAt
    });
    expect(fs.readFileSync(job.notificationOutboxFile, "utf8"))
      .not.toContain("actual-super-secret-value");
    expect(timers.timers.every((timer) => !timer.active)).toBe(true);
  });

  it("reschedules a retry from fresh settlement time after an ordinary lease-renewal failure", async () => {
    const cwd = makeCwd();
    const { job } = await makeDelivery(cwd);
    const adapter = deferred<DeliveryAttemptResult>();
    const timers = manualLeaseTimers();
    let nowMs = Date.parse(createdAt);

    const dispatch = dispatchNextDelivery(cwd, {
      now: () => new Date(nowMs),
      deliver: () => adapter.promise,
      renewDeliveryLease: async () => {
        throw new Error("temporary lock failure");
      },
      scheduleLeaseRenewal: timers.scheduleLeaseRenewal,
      cancelLeaseRenewal: timers.cancelLeaseRenewal
    });
    await vi.waitFor(() => expect(timers.scheduleLeaseRenewal).toHaveBeenCalledOnce());
    nowMs += 5_000;
    await timers.fireNext();
    nowMs += 2_000;
    adapter.resolve({ outcome: "retry", error: "offline" });

    await expect(dispatch).resolves.toMatchObject({ outcome: "settled" });
    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      nextAttemptAt: "2026-07-16T00:00:17.000Z",
      lastError: "offline"
    });
    expect(timers.timers.every((timer) => !timer.active)).toBe(true);
  });

  it("returns stale when settlement finds a newer generation after an ordinary renewal failure", async () => {
    const cwd = makeCwd();
    const { job } = await makeDelivery(cwd);
    const adapter = deferred<DeliveryAttemptResult>();
    const timers = manualLeaseTimers();
    let nowMs = Date.parse(createdAt);

    const dispatch = dispatchNextDelivery(cwd, {
      now: () => new Date(nowMs),
      leaseMs: 30_000,
      deliver: () => adapter.promise,
      renewDeliveryLease: async () => {
        throw new Error("temporary parse failure");
      },
      scheduleLeaseRenewal: timers.scheduleLeaseRenewal,
      cancelLeaseRenewal: timers.cancelLeaseRenewal
    });
    await vi.waitFor(() => expect(timers.scheduleLeaseRenewal).toHaveBeenCalledOnce());
    await timers.fireNext();
    nowMs += 31_000;
    await claimDueDelivery(job.notificationOutboxFile, new Date(nowMs), 30_000);
    adapter.resolve({ outcome: "delivered" });

    await expect(dispatch).resolves.toMatchObject({ outcome: "stale" });
    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
      status: "delivering",
      attempts: 2
    });
    expect(timers.timers.every((timer) => !timer.active)).toBe(true);
  });

  it("does not settle an old generation after an explicit stale renewal rejection", async () => {
    const cwd = makeCwd();
    const { job } = await makeDelivery(cwd);
    const adapter = deferred<DeliveryAttemptResult>();
    const timers = manualLeaseTimers();

    const dispatch = dispatchNextDelivery(cwd, {
      now: () => new Date(createdAt),
      deliver: () => adapter.promise,
      renewDeliveryLease: async () => {
        throw new StaleDeliveryGenerationError("superseded");
      },
      scheduleLeaseRenewal: timers.scheduleLeaseRenewal,
      cancelLeaseRenewal: timers.cancelLeaseRenewal
    });
    await vi.waitFor(() => expect(timers.scheduleLeaseRenewal).toHaveBeenCalledOnce());
    await timers.fireNext();
    adapter.resolve({ outcome: "delivered" });

    await expect(dispatch).resolves.toMatchObject({ outcome: "stale" });
    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
      status: "delivering",
      attempts: 1
    });
    expect(timers.timers.every((timer) => !timer.active)).toBe(true);
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
