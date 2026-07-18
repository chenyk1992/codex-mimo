import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobSignal } from "../../../src/core/job-signals.js";
import type { JobRecord } from "../../../src/core/jobs.js";
import {
  buildNotificationPayload,
  deliverWebhook,
  signWebhookBody
} from "../../../src/notify/webhook-adapter.js";
import type { NotificationDelivery } from "../../../src/notify/types.js";

const createdAt = "2026-07-16T00:00:00.000Z";
const delivery: NotificationDelivery = {
  id: "implement-1:3:webhook",
  eventId: "implement-1:3:webhook",
  jobId: "implement-1",
  signalCursor: 3,
  target: {
    type: "webhook",
    url: "https://example.test/hook",
    secretEnv: "HOOK_SECRET"
  },
  status: "delivering",
  attempts: 1,
  createdAt,
  leaseUntil: "2026-07-16T00:00:30.000Z"
};
const job: JobRecord = {
  id: "implement-1",
  kind: "implement",
  cwd: "C:\\workspace",
  task: "Implement the feature with private prompt material",
  request: { token: "request-secret" },
  status: "completed",
  createdAt,
  updatedAt: createdAt,
  completedAt: createdAt,
  summary: "Implementation completed.",
  changedFiles: ["src/feature.ts"],
  verification: [{ command: "npm test", exitCode: 0, passed: true }],
  executionCallback: {
    invocationId: "callback-1",
    outcome: "completed",
    error: "callback-private"
  },
  reportPaths: { json: ".codex-mimo/reports/implement-1.json" },
  logFile: ".codex-mimo/jobs/implement-1.log",
  eventsFile: ".codex-mimo/jobs/implement-1.events.jsonl",
  signalsFile: ".codex-mimo/jobs/implement-1.signals.jsonl",
  notificationOutboxFile: ".codex-mimo/jobs/notifications.jsonl"
};
const signal: JobSignal = {
  cursor: 3,
  jobId: "implement-1",
  kind: "completed",
  level: "info",
  createdAt,
  status: "completed",
  summary: "Implementation completed."
};

describe("webhook adapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds only the compact version-1 notification payload", () => {
    const payload = buildNotificationPayload(delivery, job, signal);

    expect(Object.keys(payload)).toEqual([
      "version",
      "eventId",
      "event",
      "createdAt",
      "job",
      "result"
    ]);
    expect(payload).toEqual({
      version: 1,
      eventId: delivery.eventId,
      event: "completed",
      createdAt,
      job: {
        id: "implement-1",
        kind: "implement",
        status: "completed",
        summary: "MiMoCode completed the job."
      },
      result: {
        changedFiles: ["src/feature.ts"],
        verification: [{ command: "npm test", exitCode: 0, passed: true }],
        reportPaths: { json: ".codex-mimo/reports/implement-1.json" }
      }
    });
    expect(JSON.stringify(payload)).not.toContain("private");
    expect(JSON.stringify(payload)).not.toContain("request-secret");
  });

  it("defensively replaces direct multiline and oversized summaries", () => {
    const marker = `WEBHOOK_DIRECT_SENTINEL\n${"x".repeat(5_000)}`;
    const payload = buildNotificationPayload(
      delivery,
      { ...job, summary: marker },
      { ...signal, summary: marker }
    );

    expect(payload.job.summary).not.toContain("WEBHOOK_DIRECT_SENTINEL");
    expect(payload.job.summary).not.toMatch(/[\r\n]/);
    expect(payload.job.summary.length).toBeLessThanOrEqual(160);
  });

  it("signs the supplied UTF-8 body", () => {
    const body = JSON.stringify({ message: "精确字节" });

    expect(signWebhookBody(body, "secret")).toBe(
      createHmac("sha256", "secret").update(Buffer.from(body, "utf8")).digest("hex")
    );
  });

  it("signs exactly the compact serialized body", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => (
      { status: 204, ok: true } as Response
    ));

    const result = await deliverWebhook(
      delivery,
      job,
      signal,
      { HOOK_SECRET: "secret" },
      fetch
    );
    const init = fetch.mock.calls[0][1]!;
    const body = String(init.body);

    expect(fetch.mock.calls[0][0]).toBe("https://example.test/hook");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      "X-Codex-Mimo-Event-Id": delivery.eventId,
      "X-Codex-Mimo-Signature": createHmac("sha256", "secret")
        .update(Buffer.from(body, "utf8"))
        .digest("hex")
    });
    expect(body).toBe(JSON.stringify(buildNotificationPayload(delivery, job, signal)));
    expect(body).not.toContain("secret");
    expect(result).toEqual({ outcome: "delivered" });
  });

  it.each([
    [408, "retry"],
    [429, "retry"],
    [500, "retry"],
    [599, "retry"],
    [600, "permanent"],
    [300, "permanent"],
    [404, "permanent"]
  ] as const)("classifies HTTP %s as %s", async (status, outcome) => {
    const fetch = vi.fn(async () => ({ status, ok: false } as Response));

    expect((await deliverWebhook(
      delivery,
      job,
      signal,
      { HOOK_SECRET: "secret" },
      fetch
    )).outcome).toBe(outcome);
  });

  it.each([undefined, ""])("permanently rejects a missing or empty secret (%s)", async (secret) => {
    const fetch = vi.fn();

    const result = await deliverWebhook(
      delivery,
      job,
      signal,
      secret === undefined ? {} : { HOOK_SECRET: secret },
      fetch
    );

    expect(result).toEqual({
      outcome: "permanent",
      error: "Webhook secret environment variable HOOK_SECRET is missing or empty"
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries fetch exceptions without exposing the secret", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("connection refused while using secret");
    });

    const result = await deliverWebhook(
      delivery,
      job,
      signal,
      { HOOK_SECRET: "secret" },
      fetch
    );

    expect(result).toEqual({
      outcome: "retry",
      error: "Webhook request failed"
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("aborts and retries a fetch that never settles before the attempt deadline", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });

    const attempt = deliverWebhook(
      delivery,
      job,
      signal,
      { HOOK_SECRET: "secret" },
      fetch,
      { timeoutMs: 100 }
    );
    await vi.advanceTimersByTimeAsync(100);

    await expect(attempt).resolves.toEqual({
      outcome: "retry",
      error: "Webhook request failed"
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "[REDACTED]",
    "RED",
    "E"
  ])("never returns a colliding secret in a transport error (%s)", async (secret) => {
    const fetch = vi.fn(async () => {
      throw new Error(`connection failed for ${secret}`);
    });

    const result = await deliverWebhook(
      delivery,
      job,
      signal,
      { HOOK_SECRET: secret },
      fetch
    );

    expect(result.outcome).toBe("retry");
    expect("error" in result ? result.error : "").not.toContain(secret);
  });
});
