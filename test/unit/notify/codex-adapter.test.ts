import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobSignal } from "../../../src/core/job-signals.js";
import type { JobRecord } from "../../../src/core/jobs.js";
import {
  CodexAppServerError,
  type CodexAppServerClient,
  type ThreadResumeResult
} from "../../../src/notify/codex-app-server.js";
import type { PreparedCodexConnection } from "../../../src/notify/codex-connection.js";
import {
  buildCodexCallbackResult,
  buildCodexNotificationPrompt,
  classifyCodexError,
  deliverCodexNotification
} from "../../../src/notify/codex-adapter.js";
import type { NotificationDelivery } from "../../../src/notify/types.js";

const createdAt = "2026-07-16T00:00:00.000Z";
const tempDirs: string[] = [];
const delivery: NotificationDelivery = {
  id: "implement-1:3:codex",
  eventId: "implement-1:3:codex",
  jobId: "implement-1",
  signalCursor: 3,
  target: { type: "codex", threadId: "thread-1" },
  status: "delivering",
  attempts: 1,
  createdAt
};
const job: JobRecord = {
  id: "implement-1",
  kind: "implement",
  cwd: "C:\\workspace",
  task: "private task prompt",
  request: { secret: "request-secret" },
  status: "completed",
  createdAt,
  updatedAt: createdAt,
  summary: "private job summary",
  changedFiles: [],
  verification: [],
  executionCallback: {
    invocationId: "private-callback",
    outcome: "completed",
    error: "callback-secret"
  },
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function jobWithEvents(text: string, overrides: Partial<JobRecord> = {}): JobRecord {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-adapter-"));
  tempDirs.push(dir);
  const eventsFile = path.join(dir, "implement-1.events.jsonl");
  fs.writeFileSync(
    eventsFile,
    JSON.stringify({ type: "text", timestamp: createdAt, text }) + "\n",
    "utf8"
  );
  return { ...job, eventsFile, ...overrides };
}

function fakeClient(result: ThreadResumeResult = { exists: true, busy: false }): CodexAppServerClient & {
  initialize: ReturnType<typeof vi.fn>;
  resumeThread: ReturnType<typeof vi.fn>;
  startTurnAndWait: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    initialize: vi.fn(async () => undefined),
    resumeThread: vi.fn(async () => result),
    startTurnAndWait: vi.fn(async () => ({
      turnId: "turn-1",
      status: "completed" as const
    })),
    close: vi.fn(async () => undefined)
  };
}

function preparedConnection(
  client: CodexAppServerClient,
  thread: ThreadResumeResult = { exists: true, busy: false }
): PreparedCodexConnection {
  return {
    probe: { ok: true, source: "path" },
    client,
    thread
  };
}

describe("Codex notification adapter", () => {
  it("attaches one public final result and forbids callback tool calls", () => {
    const prepared = jobWithEvents("CODEX_MIMO_NOTIFY_SMOKE_OUTPUT_v1");
    const prompt = buildCodexNotificationPrompt(delivery, prepared, signal);

    expect(prompt.startsWith("MIMO_CALLBACK_RESULT_V1\n")).toBe(true);
    expect(prompt).toContain('notification event "implement-1:3:codex"');
    expect(prompt).toContain("Do not call mimo_result, mimo_status, mimo_events, mimo_wait, or any other tool.");
    expect(prompt).toContain("<mimo_callback_result>");
    expect(prompt).toContain('"output":"CODEX_MIMO_NOTIFY_SMOKE_OUTPUT_v1"');
    expect(prompt).toContain("</mimo_callback_result>");
    expect(prompt).not.toContain("Call mimo_result");
    expect(prompt).not.toContain("private task prompt");
    expect(prompt).not.toContain("request-secret");
    expect(prompt).not.toContain('"actions"');
    expect(prompt).not.toContain('"notification"');
  });

  it("creates a partial callback result without actions or notification", () => {
    const result = buildCodexCallbackResult({ ...job, status: "needs_input" });
    expect(result).toMatchObject({ jobId: "implement-1", status: "needs_input", resultType: "partial" });
    expect(result).not.toHaveProperty("actions");
    expect(result).not.toHaveProperty("notification");
  });

  it("starts exactly one new turn for an already prepared idle thread", async () => {
    const prepared = jobWithEvents("CODEX_MIMO_NOTIFY_SMOKE_OUTPUT_v1");
    const calls: string[] = [];
    const client: CodexAppServerClient = {
      initialize: async () => { throw new Error("adapter must not initialize"); },
      resumeThread: async () => { throw new Error("adapter must not resume"); },
      startTurnAndWait: async (threadId, prompt) => {
        calls.push(`turn:${threadId}`);
        expect(prompt.startsWith("MIMO_CALLBACK_RESULT_V1\n")).toBe(true);
        expect(prompt).toContain('"output":"CODEX_MIMO_NOTIFY_SMOKE_OUTPUT_v1"');
        expect(prompt).not.toContain("Call mimo_result");
        return { turnId: "turn-1", status: "completed" };
      },
      close: async () => { calls.push("close"); }
    };

    await expect(deliverCodexNotification(
      delivery,
      prepared,
      signal,
      preparedConnection(client)
    )).resolves.toEqual({
      outcome: "delivered"
    });
    expect(calls).toEqual(["turn:thread-1", "close"]);
  });

  it("retries an already prepared busy thread without starting a turn", async () => {
    const client = fakeClient({ exists: true, busy: true });

    expect(await deliverCodexNotification(
      delivery,
      job,
      signal,
      preparedConnection(client, { exists: true, busy: true })
    )).toEqual({
      outcome: "retry",
      error: "Codex thread is busy",
      errorCode: "codex_thread_busy"
    });
    expect(client.initialize).not.toHaveBeenCalled();
    expect(client.resumeThread).not.toHaveBeenCalled();
    expect(client.startTurnAndWait).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("returns permanent when the original thread is missing", async () => {
    const client = fakeClient({ exists: false, busy: false });

    expect(await deliverCodexNotification(
      delivery,
      job,
      signal,
      preparedConnection(client, { exists: false, busy: false })
    )).toEqual({
      outcome: "permanent",
      error: "Codex thread does not exist",
      errorCode: "codex_thread_missing"
    });
    expect(client.startTurnAndWait).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("returns the preparation failure when the original thread is forbidden", async () => {
    const client = fakeClient();

    expect(await deliverCodexNotification(delivery, job, signal, {
      probe: { ok: false, source: "path", errorCode: "codex_thread_forbidden" },
      client
    })).toEqual({
      outcome: "permanent",
      error: "Codex thread is forbidden",
      errorCode: "codex_thread_forbidden"
    });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it.each(["startTurnAndWait"] as const)(
    "retries a transport failure from %s",
    async (method) => {
      const client = fakeClient();
      client[method].mockRejectedValueOnce(
        new CodexAppServerError("codex_app_server_unavailable", "private transport detail")
      );

      expect(await deliverCodexNotification(
        delivery,
        job,
        signal,
        preparedConnection(client)
      )).toEqual({
        outcome: "retry",
        error: "Codex App Server request failed",
        errorCode: "codex_app_server_unavailable"
      });
      expect(client.close).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ["interrupted", "codex_turn_interrupted", "Codex callback turn was interrupted"],
    ["failed", "codex_turn_failed", "Codex callback turn failed"]
  ] as const)("retries callback status %s", async (status, errorCode, error) => {
    const client = fakeClient();
    client.startTurnAndWait.mockResolvedValueOnce({ turnId: "turn-1", status });

    await expect(deliverCodexNotification(
      delivery,
      job,
      signal,
      preparedConnection(client)
    )).resolves.toEqual({ outcome: "retry", error, errorCode });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("retries a callback turn timeout", async () => {
    const client = fakeClient();
    client.startTurnAndWait.mockRejectedValueOnce(
      new CodexAppServerError("codex_turn_timeout", "Codex callback turn timed out")
    );

    expect(await deliverCodexNotification(
      delivery,
      job,
      signal,
      preparedConnection(client)
    )).toEqual({
      outcome: "retry",
      error: "Codex callback turn timed out",
      errorCode: "codex_turn_timeout"
    });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("keeps the client open until callback completion settles", async () => {
    let resolveCompletion!: (value: { turnId: string; status: "completed" }) => void;
    const completion = new Promise<{ turnId: string; status: "completed" }>((resolve) => {
      resolveCompletion = resolve;
    });
    const client = fakeClient();
    client.startTurnAndWait.mockReturnValueOnce(completion);

    const deliveryPromise = deliverCodexNotification(
      delivery,
      job,
      signal,
      preparedConnection(client)
    );
    await Promise.resolve();
    expect(client.close).not.toHaveBeenCalled();

    resolveCompletion({ turnId: "turn-1", status: "completed" });
    await expect(deliveryPromise).resolves.toEqual({ outcome: "delivered" });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("keeps the primary permanent result when close also fails", async () => {
    const client = fakeClient();
    client.resumeThread.mockRejectedValueOnce(
      new CodexAppServerError("codex_thread_forbidden", "Codex thread is forbidden")
    );
    client.close.mockRejectedValueOnce(new Error("close private detail"));

    expect(await deliverCodexNotification(
      delivery,
      job,
      signal,
      { probe: { ok: false, source: "path", errorCode: "codex_thread_forbidden" }, client }
    )).toEqual({
      outcome: "permanent",
      error: "Codex thread is forbidden",
      errorCode: "codex_thread_forbidden"
    });
  });

  it("keeps a completed turn delivered when best-effort close fails", async () => {
    const client = fakeClient();
    client.close.mockRejectedValueOnce(new Error("close private detail"));

    expect(await deliverCodexNotification(
      delivery,
      job,
      signal,
      preparedConnection(client)
    )).toEqual({
      outcome: "delivered"
    });
    expect(client.startTurnAndWait).toHaveBeenCalledOnce();
  });

  it("keeps a pre-completion transport failure when close also fails", async () => {
    const client = fakeClient();
    client.startTurnAndWait.mockRejectedValueOnce(
      new CodexAppServerError("codex_app_server_unavailable", "private transport detail")
    );
    client.close.mockRejectedValueOnce(new Error("close private detail"));

    expect(await deliverCodexNotification(
      delivery,
      job,
      signal,
      preparedConnection(client)
    )).toEqual({
      outcome: "retry",
      error: "Codex App Server request failed",
      errorCode: "codex_app_server_unavailable"
    });
  });

  it("classifies malformed protocol as permanent incompatibility", () => {
    expect(classifyCodexError(new CodexAppServerError(
      "codex_app_server_incompatible",
      "Codex App Server protocol is incompatible"
    ))).toEqual({
      outcome: "permanent",
      error: "Codex App Server protocol is incompatible",
      errorCode: "codex_app_server_incompatible"
    });
  });

  it("classifies transport and timeout failures as retryable unavailability", () => {
    expect(classifyCodexError(new CodexAppServerError(
      "codex_app_server_unavailable",
      "Codex App Server request failed"
    ))).toEqual({
      outcome: "retry",
      error: "Codex App Server request failed",
      errorCode: "codex_app_server_unavailable"
    });
  });

  it("permanently rejects a non-Codex target", async () => {
    const client = fakeClient();

    expect(await deliverCodexNotification(
      {
        ...delivery,
        target: { type: "webhook", url: "https://example.test", secretEnv: "SECRET" }
      },
      job,
      signal,
      preparedConnection(client)
    )).toEqual({ outcome: "permanent", error: "Notification target is not Codex" });
    expect(client.initialize).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
  });
});
