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
  renewDeliveryLease,
  retryDelivery
} from "../../../src/notify/outbox.js";
import { StaleDeliveryGenerationError } from "../../../src/notify/types.js";
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
  it("exposes one async enqueue contract without a filesystem lock artifact", async () => {
    const file = tempOutbox();
    const pending = enqueueDelivery(file, {
      jobId: "async-1",
      signalCursor: 1,
      target,
      createdAt: now
    });

    expect(pending).toBeInstanceOf(Promise);
    await pending;
    expect(fs.existsSync(path.join(path.dirname(file), "notifications.lock"))).toBe(false);
  });

  it("deduplicates job cursor and target kind", async () => {
    const file = tempOutbox();
    const { delivery: first, created: firstCreated } = await enqueueDelivery(file, {
      jobId: "implement-1",
      signalCursor: 3,
      target,
      createdAt: now
    });
    const { delivery: second, created: secondCreated } = await enqueueDelivery(file, {
      jobId: "implement-1",
      signalCursor: 3,
      target,
      createdAt: now
    });

    expect(firstCreated).toBe(true);
    expect(secondCreated).toBe(false);
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

  it("recovers an expired delivering lease", async () => {
    const file = tempOutbox();
    await enqueueDelivery(file, {
      jobId: "plan-1",
      signalCursor: 1,
      target,
      createdAt: now
    });

    const first = (await claimDueDelivery(file, new Date(now), 30_000))!;

    expect(first).toMatchObject({ status: "delivering", attempts: 1 });
    expect(await claimDueDelivery(file, new Date("2026-07-16T00:00:10.000Z"), 30_000))
      .toBeUndefined();
    expect(await claimDueDelivery(file, new Date("2026-07-16T00:00:31.000Z"), 30_000))
      .toMatchObject({ id: first.id, status: "delivering", attempts: 2 });
  });

  it("atomically renews only the current delivery generation", async () => {
    const file = tempOutbox();
    const { delivery } = await enqueueDelivery(file, {
      jobId: "plan-renew-1",
      signalCursor: 1,
      target,
      createdAt: now
    });
    const claim = (await claimDueDelivery(file, new Date(now), 30_000))!;

    const renewed = await renewDeliveryLease(
      file,
      delivery.id,
      claim.attempts,
      new Date("2026-07-16T00:00:10.000Z"),
      30_000
    );

    expect(renewed).toMatchObject({
      status: "delivering",
      attempts: 1,
      leaseUntil: "2026-07-16T00:00:40.000Z"
    });
    expect(await claimDueDelivery(file, new Date("2026-07-16T00:00:31.000Z"), 30_000))
      .toBeUndefined();
  });

  it("reports a typed stale generation without overwriting a reclaimed or terminal delivery", async () => {
    const file = tempOutbox();
    const { delivery } = await enqueueDelivery(file, {
      jobId: "plan-renew-2",
      signalCursor: 1,
      target,
      createdAt: now
    });
    const first = (await claimDueDelivery(file, new Date(now), 30_000))!;
    const second = (await claimDueDelivery(
      file,
      new Date("2026-07-16T00:00:31.000Z"),
      30_000
    ))!;

    await expect(renewDeliveryLease(
      file,
      delivery.id,
      first.attempts,
      new Date("2026-07-16T00:00:32.000Z"),
      30_000
    )).rejects.toBeInstanceOf(StaleDeliveryGenerationError);
    expect(readDeliveries(file)[0]).toMatchObject({ status: "delivering", attempts: 2 });

    await completeDelivery(file, delivery.id, second.attempts, new Date("2026-07-16T00:00:33.000Z"));
    await expect(renewDeliveryLease(
      file,
      delivery.id,
      second.attempts,
      new Date("2026-07-16T00:00:34.000Z"),
      30_000
    )).rejects.toMatchObject({ code: "STALE_DELIVERY_GENERATION" });
    expect(readDeliveries(file)[0]).toMatchObject({ status: "delivered", attempts: 2 });
  });

  it("appends complete snapshots for retry, delivery, and failure", async () => {
    const file = tempOutbox();
    const { delivery: first } = await enqueueDelivery(file, {
      jobId: "review-1",
      signalCursor: 2,
      target,
      createdAt: now
    });
    const firstClaim = (await claimDueDelivery(file, new Date(now), 30_000))!;

    const retried = await retryDelivery(
      file,
      first.id,
      firstClaim.attempts,
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

    const secondClaim = (await claimDueDelivery(
      file,
      new Date("2026-07-16T00:00:10.000Z"),
      30_000
    ))!;
    const delivered = await completeDelivery(
      file,
      first.id,
      secondClaim.attempts,
      new Date("2026-07-16T00:00:11.000Z")
    );
    expect(delivered).toMatchObject({
      status: "delivered",
      attempts: 2,
      deliveredAt: "2026-07-16T00:00:11.000Z"
    });
    expect(delivered.leaseUntil).toBeUndefined();

    const { delivery: second } = await enqueueDelivery(file, {
      jobId: "review-1",
      signalCursor: 3,
      target,
      createdAt: now
    });
    const failureClaim = (await claimDueDelivery(file, new Date(now), 30_000))!;
    expect(await failDelivery(file, second.id, failureClaim.attempts, "bad target")).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "bad target"
    });
    expect(readDeliveries(file)).toHaveLength(2);
    expect(fs.readFileSync(file, "utf8").trim().split(/\r?\n/)).toHaveLength(8);
  });

  it("ignores malformed journal lines during replay", async () => {
    const file = tempOutbox();
    const { delivery } = await enqueueDelivery(file, {
      jobId: "fix-1",
      signalCursor: 4,
      target,
      createdAt: now
    });
    fs.appendFileSync(file, "not-json\n{\"id\":\"incomplete\"}\n", "utf8");

    expect(readDeliveries(file)).toEqual([delivery]);
  });

  it("does not claim a pending delivery before its retry time", async () => {
    const file = tempOutbox();
    const { delivery } = await enqueueDelivery(file, {
      jobId: "fix-ci-1",
      signalCursor: 5,
      target,
      createdAt: now
    });
    const claim = (await claimDueDelivery(file, new Date(now), 30_000))!;
    await retryDelivery(
      file,
      delivery.id,
      claim.attempts,
      new Date("2026-07-16T00:01:00.000Z"),
      "busy"
    );

    expect(await claimDueDelivery(file, new Date("2026-07-16T00:00:59.999Z"), 30_000))
      .toBeUndefined();
    expect((await claimDueDelivery(file, new Date("2026-07-16T00:01:00.000Z"), 30_000))?.id)
      .toBe(delivery.id);
  });

  it("does not return a delivered delivery to pending", async () => {
    const file = tempOutbox();
    const { delivery } = await enqueueDelivery(file, {
      jobId: "implement-2",
      signalCursor: 1,
      target,
      createdAt: now
    });
    const claim = (await claimDueDelivery(file, new Date(now), 30_000))!;
    await completeDelivery(file, delivery.id, claim.attempts, new Date(now));

    await expect(retryDelivery(
      file,
      delivery.id,
      claim.attempts,
      new Date("2026-07-16T00:01:00.000Z"),
      "late"
    )).rejects.toThrow("not delivering");
    expect(readDeliveries(file)[0].status).toBe("delivered");
  });

  it("does not overwrite failed and delivered terminal outcomes", async () => {
    const file = tempOutbox();
    const { delivery: failed } = await enqueueDelivery(file, {
      jobId: "implement-3",
      signalCursor: 1,
      target,
      createdAt: now
    });
    const failedClaim = (await claimDueDelivery(file, new Date(now), 30_000))!;
    await failDelivery(file, failed.id, failedClaim.attempts, "permanent");
    await expect(completeDelivery(
      file,
      failed.id,
      failedClaim.attempts,
      new Date(now)
    )).rejects.toThrow("not delivering");

    const { delivery: delivered } = await enqueueDelivery(file, {
      jobId: "implement-3",
      signalCursor: 2,
      target,
      createdAt: now
    });
    const deliveredClaim = (await claimDueDelivery(file, new Date(now), 30_000))!;
    await completeDelivery(file, delivered.id, deliveredClaim.attempts, new Date(now));
    await expect(failDelivery(
      file,
      delivered.id,
      deliveredClaim.attempts,
      "too late"
    )).rejects.toThrow("not delivering");

    expect(readDeliveries(file).map((item) => item.status)).toEqual(["failed", "delivered"]);
  });

  it("rejects every mutation from a worker whose lease was reclaimed", async () => {
    const file = tempOutbox();
    const { delivery } = await enqueueDelivery(file, {
      jobId: "implement-4",
      signalCursor: 1,
      target,
      createdAt: now
    });
    const first = (await claimDueDelivery(file, new Date(now), 30_000))!;
    const second = (await claimDueDelivery(file, new Date("2026-07-16T00:00:31.000Z"), 30_000))!;

    await expect(completeDelivery(
      file,
      delivery.id,
      first.attempts,
      new Date("2026-07-16T00:00:32.000Z")
    )).rejects.toThrow("lease generation");
    await expect(retryDelivery(
      file,
      delivery.id,
      first.attempts,
      new Date("2026-07-16T00:01:00.000Z"),
      "stale"
    )).rejects.toThrow("lease generation");
    await expect(failDelivery(
      file,
      delivery.id,
      first.attempts,
      "stale"
    )).rejects.toThrow("lease generation");

    expect((await completeDelivery(
      file,
      delivery.id,
      second.attempts,
      new Date("2026-07-16T00:00:32.000Z")
    )).status).toBe("delivered");
  });

  it("strips secrets and extra fields from replayed snapshots and later mutations", async () => {
    const file = tempOutbox();
    const id = "review-2:1:webhook";
    fs.writeFileSync(file, `${JSON.stringify({
      id,
      eventId: id,
      jobId: "review-2",
      signalCursor: 1,
      target: {
        type: "webhook",
        url: "https://example.test/hook",
        secretEnv: "HOOK_SECRET",
        secret: "target-secret"
      },
      status: "delivering",
      attempts: 1,
      createdAt: now,
      leaseUntil: "2026-07-16T00:00:30.000Z",
      secretValue: "top-level-secret",
      arbitrary: { nested: true }
    })}\n`, "utf8");

    const replayed = readDeliveries(file)[0];
    expect(replayed).toEqual({
      id,
      eventId: id,
      jobId: "review-2",
      signalCursor: 1,
      target: {
        type: "webhook",
        url: "https://example.test/hook",
        secretEnv: "HOOK_SECRET"
      },
      status: "delivering",
      attempts: 1,
      createdAt: now,
      leaseUntil: "2026-07-16T00:00:30.000Z"
    });

    await failDelivery(file, id, replayed.attempts, "permanent");
    const lastLine = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).at(-1)!;
    expect(lastLine).not.toContain("target-secret");
    expect(lastLine).not.toContain("top-level-secret");
    expect(lastLine).not.toContain("arbitrary");
  });

  it.each([
    ["id", { id: "identity-1:2:codex" }],
    ["eventId", { eventId: "identity-1:2:codex" }],
    ["jobId", { jobId: "different-job" }],
    ["signal cursor", { signalCursor: 99 }],
    ["target kind", {
      target: {
        type: "webhook",
        url: "https://example.test/hook",
        secretEnv: "HOOK_SECRET"
      }
    }]
  ])("skips a snapshot with a mismatched %s identity", async (_name, identityPatch) => {
    const file = tempOutbox();
    const { delivery: first } = await enqueueDelivery(file, {
      jobId: "identity-1",
      signalCursor: 1,
      target,
      createdAt: now
    });
    const { delivery: second } = await enqueueDelivery(file, {
      jobId: "identity-1",
      signalCursor: 2,
      target,
      createdAt: now
    });
    fs.appendFileSync(file, `${JSON.stringify({ ...first, ...identityPatch })}\n`, "utf8");

    expect(readDeliveries(file)).toEqual([first, second]);
  });

  it.each([
    ["invalid createdAt", { createdAt: "not-a-date" }],
    ["invalid nextAttemptAt", { nextAttemptAt: "not-a-date" }],
    ["delivering without a lease", { status: "delivering", attempts: 1 }],
    ["delivering with an invalid lease", {
      status: "delivering",
      attempts: 1,
      leaseUntil: "not-a-date"
    }],
    ["delivered without deliveredAt", { status: "delivered", attempts: 1 }],
    ["delivered with an active lease", {
      status: "delivered",
      attempts: 1,
      deliveredAt: now,
      leaseUntil: "2026-07-16T00:00:30.000Z"
    }],
    ["pending with deliveredAt", { deliveredAt: now }],
    ["failed with an active lease", {
      status: "failed",
      attempts: 1,
      leaseUntil: "2026-07-16T00:00:30.000Z"
    }],
    ["pending retry with zero attempts", {
      attempts: 0,
      nextAttemptAt: "2026-07-16T00:00:30.000Z"
    }],
    ["delivering with zero attempts", {
      status: "delivering",
      attempts: 0,
      leaseUntil: "2026-07-16T00:00:30.000Z"
    }],
    ["delivered with zero attempts", {
      status: "delivered",
      attempts: 0,
      deliveredAt: now
    }],
    ["failed with zero attempts", {
      status: "failed",
      attempts: 0
    }]
  ])("skips a later %s snapshot and keeps the prior delivery claimable", async (_name, invalidPatch) => {
    const file = tempOutbox();
    const { delivery } = await enqueueDelivery(file, {
      jobId: "fix-2",
      signalCursor: 1,
      target,
      createdAt: now
    });
    fs.appendFileSync(file, `${JSON.stringify({ ...delivery, ...invalidPatch })}\n`, "utf8");

    expect(readDeliveries(file)).toEqual([delivery]);
    expect((await claimDueDelivery(file, new Date(now), 30_000))?.id).toBe(delivery.id);
  });
});
