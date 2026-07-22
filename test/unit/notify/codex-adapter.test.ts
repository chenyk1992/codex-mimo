import { describe, expect, it, vi } from "vitest";
import type { JobSignal } from "../../../src/core/job-signals.js";
import type { JobRecord } from "../../../src/core/jobs.js";
import {
  CodexAppServerError,
  type CodexAppServerClient,
  type ThreadResumeResult
} from "../../../src/notify/codex-app-server.js";
import type { PreparedCodexConnection } from "../../../src/notify/codex-connection.js";
import {
  buildCodexNotificationPrompt,
  classifyCodexError,
  deliverCodexNotification
} from "../../../src/notify/codex-adapter.js";
import type { NotificationDelivery } from "../../../src/notify/types.js";

const createdAt = "2026-07-16T00:00:00.000Z";
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
  it("includes the frozen cwd required to fetch the notified job result", () => {
    const prompt = buildCodexNotificationPrompt(delivery, job, signal);

    expect(prompt).toContain('notification event "implement-1:3:codex"');
    expect(prompt).toContain("may be a retry");
    expect(prompt).toContain('Call mimo_result with cwd "C:\\\\workspace"');
    expect(prompt).toContain('and jobId "implement-1"');
  });

  it("keeps long frozen identifiers exact even when the callback prompt exceeds the compact target", () => {
    const cwd = `C:\\\\${"nested\\\\".repeat(40)}quoted-\"目录`;
    const jobId = `implement-${"x".repeat(260)}-\"quoted\"`;

    const prompt = buildCodexNotificationPrompt(
      { ...delivery, id: `${jobId}:3:codex`, eventId: `${jobId}:3:codex`, jobId },
      { ...job, cwd, id: jobId },
      signal
    );

    expect(prompt).toContain(`cwd ${JSON.stringify(cwd)}`);
    expect(prompt).toContain(`jobId ${JSON.stringify(jobId)}`);
    expect(prompt.length).toBeGreaterThan(240);
  });

  it("starts exactly one new turn for an already prepared idle thread", async () => {
    const calls: string[] = [];
    const client: CodexAppServerClient = {
      initialize: async () => { throw new Error("adapter must not initialize"); },
      resumeThread: async () => { throw new Error("adapter must not resume"); },
      startTurnAndWait: async (threadId, prompt) => {
        calls.push(`turn:${threadId}:${prompt}`);
        return { turnId: "turn-1", status: "completed" };
      },
      close: async () => { calls.push("close"); }
    };

    await expect(deliverCodexNotification(
      delivery,
      job,
      signal,
      preparedConnection(client)
    )).resolves.toEqual({
      outcome: "delivered"
    });
    expect(calls).toEqual([
      'turn:thread-1:MiMoCode notification event "implement-1:3:codex" emitted completed and may be a retry. Call mimo_result with cwd "C:\\\\workspace" and jobId "implement-1"; continue handling the original request.',
      "close"
    ]);
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

  it("builds one compact line without private job fields", () => {
    const inputSignal: JobSignal = {
      ...signal,
      kind: "needs_input",
      status: "needs_input",
      summary: "Need   the API token\r\nfrom the operator."
    };

    const prompt = buildCodexNotificationPrompt(delivery, job, inputSignal);

    expect(prompt).toBe(
      'MiMoCode notification event "implement-1:3:codex" emitted needs_input and may be a retry. Call mimo_result with cwd "C:\\\\workspace" and jobId "implement-1"; continue handling the original request. Reason: MiMoCode needs additional input.'
    );
    expect(prompt).not.toContain("private task prompt");
    expect(prompt).not.toContain("request-secret");
    expect(prompt).not.toContain("private-callback");
    expect(prompt).not.toContain("callback-secret");
    expect(prompt).not.toMatch(/[\r\n]/);
    expect(prompt.length).toBeLessThanOrEqual(240);
  });

  it("caps blocked prompts at 240 characters", () => {
    const blockedSignal: JobSignal = {
      ...signal,
      kind: "blocked",
      status: "blocked",
      summary: `Blocked ${"because ".repeat(100)}`
    };

    const prompt = buildCodexNotificationPrompt(delivery, job, blockedSignal);

    expect(prompt).toContain(" Reason: MiMoCode is blocked by an external cond");
    expect(prompt.length).toBe(240);
    expect(prompt).not.toMatch(/[\r\n]/);
  });

  it("does not append a reason for terminal events", () => {
    expect(buildCodexNotificationPrompt(delivery, job, signal)).toBe(
      'MiMoCode notification event "implement-1:3:codex" emitted completed and may be a retry. Call mimo_result with cwd "C:\\\\workspace" and jobId "implement-1"; continue handling the original request.'
    );
  });

  it("preserves an unexpectedly long internal job id in terminal prompts", () => {
    const jobId = `implement-${"x".repeat(500)}`;
    const prompt = buildCodexNotificationPrompt(
      { ...delivery, id: `${jobId}:3:codex`, eventId: `${jobId}:3:codex`, jobId },
      { ...job, id: jobId },
      signal
    );

    expect(prompt).toContain(`jobId ${JSON.stringify(jobId)}`);
    expect(prompt.length).toBeGreaterThan(240);
    expect(prompt).not.toMatch(/[\r\n]/);
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
