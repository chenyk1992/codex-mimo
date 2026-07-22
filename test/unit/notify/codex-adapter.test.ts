import { describe, expect, it, vi } from "vitest";
import type { JobSignal } from "../../../src/core/job-signals.js";
import type { JobRecord } from "../../../src/core/jobs.js";
import {
  CodexAppServerError,
  type CodexAppServerClient,
  type ThreadResumeResult
} from "../../../src/notify/codex-app-server.js";
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
  startTurn: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    initialize: vi.fn(async () => undefined),
    resumeThread: vi.fn(async () => result),
    startTurn: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
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

  it("resumes an idle thread and starts exactly one new turn", async () => {
    const calls: string[] = [];
    const client: CodexAppServerClient = {
      initialize: async () => { calls.push("initialize"); },
      resumeThread: async (threadId) => {
        calls.push(`resume:${threadId}`);
        return { exists: true, busy: false };
      },
      startTurn: async (threadId, prompt) => { calls.push(`turn:${threadId}:${prompt}`); },
      close: async () => { calls.push("close"); }
    };

    await expect(deliverCodexNotification(delivery, job, signal, client)).resolves.toEqual({
      outcome: "delivered"
    });
    expect(calls).toEqual([
      "initialize",
      "resume:thread-1",
      'turn:thread-1:MiMoCode notification event "implement-1:3:codex" emitted completed and may be a retry. Call mimo_result with cwd "C:\\\\workspace" and jobId "implement-1"; continue handling the original request.',
      "close"
    ]);
  });

  it("returns retry while the original turn is active", async () => {
    const client = fakeClient({ exists: true, busy: true });

    expect(await deliverCodexNotification(delivery, job, signal, client)).toEqual({
      outcome: "retry",
      error: "Codex thread is busy",
      errorCode: "codex_thread_busy"
    });
    expect(client.startTurn).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("returns permanent when the original thread is missing", async () => {
    const client = fakeClient({ exists: false, busy: false });

    expect(await deliverCodexNotification(delivery, job, signal, client)).toEqual({
      outcome: "permanent",
      error: "Codex thread does not exist",
      errorCode: "codex_thread_missing"
    });
    expect(client.startTurn).not.toHaveBeenCalled();
  });

  it("returns permanent when the original thread is forbidden", async () => {
    const client = fakeClient();
    client.resumeThread.mockRejectedValueOnce(
      new CodexAppServerError("codex_thread_forbidden", "Codex thread is forbidden")
    );

    expect(await deliverCodexNotification(delivery, job, signal, client)).toEqual({
      outcome: "permanent",
      error: "Codex thread is forbidden",
      errorCode: "codex_thread_forbidden"
    });
  });

  it.each(["initialize", "resumeThread", "startTurn"] as const)(
    "retries a transport failure from %s",
    async (method) => {
      const client = fakeClient();
      client[method].mockRejectedValueOnce(
        new CodexAppServerError("codex_app_server_unavailable", "private transport detail")
      );

      expect(await deliverCodexNotification(delivery, job, signal, client)).toEqual({
        outcome: "retry",
        error: "Codex App Server request failed",
        errorCode: "codex_app_server_unavailable"
      });
      expect(client.close).toHaveBeenCalledOnce();
    }
  );

  it("keeps the primary permanent result when close also fails", async () => {
    const client = fakeClient();
    client.resumeThread.mockRejectedValueOnce(
      new CodexAppServerError("codex_thread_forbidden", "Codex thread is forbidden")
    );
    client.close.mockRejectedValueOnce(new Error("close private detail"));

    expect(await deliverCodexNotification(delivery, job, signal, client)).toEqual({
      outcome: "permanent",
      error: "Codex thread is forbidden",
      errorCode: "codex_thread_forbidden"
    });
  });

  it("keeps an accepted turn delivered when best-effort close fails", async () => {
    const client = fakeClient();
    client.close.mockRejectedValueOnce(new Error("close private detail"));

    expect(await deliverCodexNotification(delivery, job, signal, client)).toEqual({
      outcome: "delivered"
    });
    expect(client.startTurn).toHaveBeenCalledOnce();
  });

  it("keeps a pre-acceptance transport failure when close also fails", async () => {
    const client = fakeClient();
    client.startTurn.mockRejectedValueOnce(
      new CodexAppServerError("codex_app_server_unavailable", "private transport detail")
    );
    client.close.mockRejectedValueOnce(new Error("close private detail"));

    expect(await deliverCodexNotification(delivery, job, signal, client)).toEqual({
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
      client
    )).toEqual({ outcome: "permanent", error: "Notification target is not Codex" });
    expect(client.initialize).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
  });
});
