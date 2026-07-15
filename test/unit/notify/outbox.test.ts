import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimDueDelivery,
  completeDelivery,
  enqueueDelivery,
  failDelivery,
  readDeliveries,
  retryDelivery
} from "../../../src/notify/outbox.js";
import type { NotificationTarget } from "../../../src/notify/types.js";

const tempDirs: string[] = [];
const target: NotificationTarget = { type: "codex", threadId: "thread-1" };
const now = "2026-07-16T00:00:00.000Z";

function tempOutbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-outbox-"));
  tempDirs.push(dir);
  return path.join(dir, "notifications.jsonl");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("notification outbox", () => {
  it("deduplicates job cursor and target kind", () => {
    const file = tempOutbox();
    const first = enqueueDelivery(file, {
      jobId: "implement-1",
      signalCursor: 3,
      target,
      createdAt: now
    });
    const second = enqueueDelivery(file, {
      jobId: "implement-1",
      signalCursor: 3,
      target,
      createdAt: now
    });

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      id: "implement-1:3:codex",
      eventId: "implement-1:3:codex",
      status: "pending",
      attempts: 0
    });
    expect(readDeliveries(file)).toHaveLength(1);
    expect(fs.readFileSync(file, "utf8").trim().split(/\r?\n/)).toHaveLength(1);
  });

  it("recovers an expired delivering lease", () => {
    const file = tempOutbox();
    enqueueDelivery(file, {
      jobId: "plan-1",
      signalCursor: 1,
      target,
      createdAt: now
    });

    const first = claimDueDelivery(file, new Date(now), 30_000)!;

    expect(first).toMatchObject({ status: "delivering", attempts: 1 });
    expect(claimDueDelivery(file, new Date("2026-07-16T00:00:10.000Z"), 30_000))
      .toBeUndefined();
    expect(claimDueDelivery(file, new Date("2026-07-16T00:00:31.000Z"), 30_000))
      .toMatchObject({ id: first.id, status: "delivering", attempts: 2 });
  });

  it("appends complete snapshots for retry, delivery, and failure", () => {
    const file = tempOutbox();
    const first = enqueueDelivery(file, {
      jobId: "review-1",
      signalCursor: 2,
      target,
      createdAt: now
    });
    claimDueDelivery(file, new Date(now), 30_000);

    const retried = retryDelivery(
      file,
      first.id,
      new Date("2026-07-16T00:00:10.000Z"),
      "offline"
    );
    expect(retried).toMatchObject({
      status: "pending",
      attempts: 1,
      nextAttemptAt: "2026-07-16T00:00:10.000Z",
      lastError: "offline"
    });
    expect(retried.leaseUntil).toBeUndefined();

    claimDueDelivery(file, new Date("2026-07-16T00:00:10.000Z"), 30_000);
    const delivered = completeDelivery(
      file,
      first.id,
      new Date("2026-07-16T00:00:11.000Z")
    );
    expect(delivered).toMatchObject({
      status: "delivered",
      attempts: 2,
      deliveredAt: "2026-07-16T00:00:11.000Z"
    });
    expect(delivered.leaseUntil).toBeUndefined();

    const second = enqueueDelivery(file, {
      jobId: "review-1",
      signalCursor: 3,
      target,
      createdAt: now
    });
    claimDueDelivery(file, new Date(now), 30_000);
    expect(failDelivery(file, second.id, "bad target")).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "bad target"
    });
    expect(readDeliveries(file)).toHaveLength(2);
    expect(fs.readFileSync(file, "utf8").trim().split(/\r?\n/)).toHaveLength(8);
  });

  it("ignores malformed journal lines during replay", () => {
    const file = tempOutbox();
    const delivery = enqueueDelivery(file, {
      jobId: "fix-1",
      signalCursor: 4,
      target,
      createdAt: now
    });
    fs.appendFileSync(file, "not-json\n{\"id\":\"incomplete\"}\n", "utf8");

    expect(readDeliveries(file)).toEqual([delivery]);
  });

  it("does not claim a pending delivery before its retry time", () => {
    const file = tempOutbox();
    const delivery = enqueueDelivery(file, {
      jobId: "fix-ci-1",
      signalCursor: 5,
      target,
      createdAt: now
    });
    claimDueDelivery(file, new Date(now), 30_000);
    retryDelivery(file, delivery.id, new Date("2026-07-16T00:01:00.000Z"), "busy");

    expect(claimDueDelivery(file, new Date("2026-07-16T00:00:59.999Z"), 30_000))
      .toBeUndefined();
    expect(claimDueDelivery(file, new Date("2026-07-16T00:01:00.000Z"), 30_000)?.id)
      .toBe(delivery.id);
  });
});
