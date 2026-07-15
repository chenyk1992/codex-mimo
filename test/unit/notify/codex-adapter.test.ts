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
      "turn:thread-1:MiMoCode job implement-1 emitted completed. Call mimo_result and continue handling the original request.",
      "close"
    ]);
  });

  it("returns retry while the original turn is active", async () => {
    const client = fakeClient({ exists: true, busy: true });

    expect((await deliverCodexNotification(delivery, job, signal, client)).outcome).toBe("retry");
    expect(client.startTurn).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("returns permanent when the original thread is missing", async () => {
    const client = fakeClient({ exists: false, busy: false });

    expect(await deliverCodexNotification(delivery, job, signal, client)).toEqual({
      outcome: "permanent",
      error: "Codex thread does not exist"
    });
    expect(client.startTurn).not.toHaveBeenCalled();
  });

  it("returns permanent when the original thread is forbidden", async () => {
    const client = fakeClient();
    client.resumeThread.mockRejectedValueOnce(
      new CodexAppServerError("forbidden", "Codex thread is forbidden")
    );

    expect(await deliverCodexNotification(delivery, job, signal, client)).toEqual({
      outcome: "permanent",
      error: "Codex thread is forbidden"
    });
  });

  it.each(["initialize", "resumeThread", "startTurn"] as const)(
    "retries a transport failure from %s",
    async (method) => {
      const client = fakeClient();
      client[method].mockRejectedValueOnce(
        new CodexAppServerError("transport", "private transport detail")
      );

      expect(await deliverCodexNotification(delivery, job, signal, client)).toEqual({
        outcome: "retry",
        error: "Codex App Server request failed"
      });
      expect(client.close).toHaveBeenCalledOnce();
    }
  );

  it("keeps the primary permanent result when close also fails", async () => {
    const client = fakeClient();
    client.resumeThread.mockRejectedValueOnce(
      new CodexAppServerError("forbidden", "Codex thread is forbidden")
    );
    client.close.mockRejectedValueOnce(new Error("close private detail"));

    expect(await deliverCodexNotification(delivery, job, signal, client)).toEqual({
      outcome: "permanent",
      error: "Codex thread is forbidden"
    });
  });

  it("retries when close is the only failure", async () => {
    const client = fakeClient();
    client.close.mockRejectedValueOnce(new Error("close private detail"));

    expect(await deliverCodexNotification(delivery, job, signal, client)).toEqual({
      outcome: "retry",
      error: "Codex App Server request failed"
    });
  });

  it("builds one compact line without private job fields", () => {
    const inputSignal: JobSignal = {
      ...signal,
      kind: "needs_input",
      status: "needs_input",
      summary: "Need   the API token\r\nfrom the operator."
    };

    const prompt = buildCodexNotificationPrompt(job, inputSignal);

    expect(prompt).toBe(
      "MiMoCode job implement-1 emitted needs_input. Call mimo_result and continue handling the original request. Reason: Need the API token from the operator."
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

    const prompt = buildCodexNotificationPrompt(job, blockedSignal);

    expect(prompt).toContain(" Reason: Blocked because because");
    expect(prompt.length).toBe(240);
    expect(prompt).not.toMatch(/[\r\n]/);
  });

  it("does not append a reason for terminal events", () => {
    expect(buildCodexNotificationPrompt(job, signal)).toBe(
      "MiMoCode job implement-1 emitted completed. Call mimo_result and continue handling the original request."
    );
  });

  it("caps terminal prompts even when the internal job id is unexpectedly long", () => {
    const prompt = buildCodexNotificationPrompt(
      { ...job, id: `implement-${"x".repeat(500)}` },
      signal
    );

    expect(prompt.length).toBe(240);
    expect(prompt.endsWith(
      " emitted completed. Call mimo_result and continue handling the original request."
    )).toBe(true);
    expect(prompt).not.toMatch(/[\r\n]/);
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
