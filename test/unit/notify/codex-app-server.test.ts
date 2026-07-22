import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import {
  CodexAppServerError,
  createCodexAppServerClient
} from "../../../src/notify/codex-app-server.js";
import { classifyCodexError } from "../../../src/notify/codex-adapter.js";

class FakeAppServerProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: NodeJS.Signals[] = [];
  unrefCalls = 0;
  private exited = false;

  constructor(
    private readonly exitOnStdinEnd = true,
    private readonly exitOnSignal: NodeJS.Signals | null = "SIGTERM"
  ) {
    super();
    this.stdin.once("finish", () => {
      if (!this.exited && this.exitOnStdinEnd) this.exit(0);
    });
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    if (signal === this.exitOnSignal) this.exit(null, signal);
    return true;
  }

  unref(): void {
    this.unrefCalls += 1;
  }

  get killCalls(): number {
    return this.killSignals.length;
  }
}

const initializeResult = {
  codexHome: "C:\\Users\\test\\.codex",
  platformFamily: "windows",
  platformOs: "windows",
  userAgent: "codex-cli/0.144.2"
};

function threadResumeResult(
  id: string,
  status: { type: string; activeFlags?: string[] }
): Record<string, unknown> {
  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "C:\\workspace",
    model: "gpt-5.4",
    modelProvider: "openai",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      cliVersion: "0.144.2",
      createdAt: 1,
      cwd: "C:\\workspace",
      ephemeral: false,
      id,
      modelProvider: "openai",
      preview: "",
      sessionId: id,
      source: { type: "appServer" },
      status,
      turns: [],
      updatedAt: 1
    }
  };
}

function turnStartResult(
  id = "turn-1",
  status: "inProgress" | "completed" | "interrupted" | "failed" = "inProgress"
): Record<string, unknown> {
  return { turn: { id, status, items: [] } };
}

function messagesFrom(process: FakeAppServerProcess): unknown[] {
  return process.stdin.readableLength === 0
    ? []
    : process.stdin.read().toString("utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function respond(process: FakeAppServerProcess, message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function initializeClient(process: FakeAppServerProcess) {
  const client = createCodexAppServerClient();
  const initialized = client.initialize();
  expect(messagesFrom(process)).toEqual([{
    method: "initialize",
    id: 1,
    params: {
      clientInfo: {
        name: "codex_mimo",
        title: "Codex MiMoCode Bridge",
        version: "0.1.0"
      }
    }
  }]);
  respond(process, { id: 1, result: initializeResult });
  await initialized;
  expect(messagesFrom(process)).toEqual([{ method: "initialized", params: {} }]);
  return client;
}

function readRpcAudit(file: string): Array<Record<string, unknown>> {
  return fs.readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("Codex App Server client", () => {
  let process: FakeAppServerProcess;
  let auditRoot: string;

  beforeEach(() => {
    auditRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-app-server-audit-"));
    process = new FakeAppServerProcess();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(process);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(auditRoot, { recursive: true, force: true });
  });

  it("spawns the stdio App Server hidden with piped streams and a UTF-8 environment", async () => {
    const client = createCodexAppServerClient();

    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      ["app-server", "--listen", "stdio://"],
      expect.objectContaining({
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: expect.objectContaining({
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8"
        })
      })
    );
    expect(spawnMock.mock.calls[0][2]).not.toHaveProperty("shell");
    expect(process.stderr.readableFlowing).toBe(true);
    await client.close();
  });

  it("spawns a configured executable directly without a shell", async () => {
    const configuredCommand = "C:\\Tools\\codex.cmd";
    const env = { CUSTOM: "value" };
    const client = createCodexAppServerClient({
      spawnProcess: spawnMock,
      env,
      command: { command: configuredCommand, source: "configured" }
    });

    expect(spawnMock).toHaveBeenCalledWith(
      configuredCommand,
      ["app-server", "--listen", "stdio://"],
      expect.objectContaining({
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: expect.objectContaining({
          CUSTOM: "value",
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8"
        })
      })
    );
    expect(spawnMock.mock.calls[0][2]).not.toHaveProperty("shell");
    await client.close();
  });

  it("writes no RPC audit when the opt-in path is absent or blank", async () => {
    delete globalThis.process.env.CODEX_MIMO_APP_SERVER_AUDIT_FILE;
    const absent = await initializeClient(process);
    await absent.close();

    process = new FakeAppServerProcess();
    spawnMock.mockReturnValue(process);
    vi.stubEnv("CODEX_MIMO_APP_SERVER_AUDIT_FILE", "   ");
    const blank = await initializeClient(process);
    await blank.close();

    expect(fs.readdirSync(auditRoot)).toEqual([]);
  });

  it("audits only allowlisted RPC metadata and never request payloads", async () => {
    const auditFile = path.join(auditRoot, "rpc.jsonl");
    vi.stubEnv("CODEX_MIMO_APP_SERVER_AUDIT_FILE", auditFile);
    const client = await initializeClient(process);

    const started = client.startTurn(
      "thread-private",
      "private prompt input reason job task payload secret"
    );
    const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
    respond(process, { id, result: turnStartResult() });
    await started;
    await client.close();

    const records = readRpcAudit(auditFile);
    expect(records).toHaveLength(2);
    expect(Object.keys(records[0]).sort()).toEqual(["method", "pid", "timestamp"]);
    expect(Object.keys(records[1]).sort()).toEqual(["method", "pid", "threadId", "timestamp"]);
    expect(records[1]).toMatchObject({
      pid: globalThis.process.pid,
      method: "turn/start",
      threadId: "thread-private"
    });
    const raw = fs.readFileSync(auditFile, "utf8");
    for (const sensitive of ["private prompt", "input", "reason", "job", "task", "payload", "secret"]) {
      expect(raw).not.toContain(sensitive);
    }
  });

  it("keeps App Server delivery behavior unchanged when the RPC audit write fails", async () => {
    vi.stubEnv("CODEX_MIMO_APP_SERVER_AUDIT_FILE", auditRoot);
    const client = await initializeClient(process);

    const resume = client.resumeThread("thread-1");
    const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
    respond(process, { id, result: threadResumeResult("thread-1", { type: "idle" }) });

    await expect(resume).resolves.toEqual({ exists: true, busy: false });
    await client.close();
  });

  it("records exactly one resume and start request for their validated thread", async () => {
    const auditFile = path.join(auditRoot, "rpc.jsonl");
    vi.stubEnv("CODEX_MIMO_APP_SERVER_AUDIT_FILE", auditFile);
    const client = await initializeClient(process);

    const resume = client.resumeThread("thread-injected");
    const [{ id: resumeId }] = messagesFrom(process) as Array<{ id: number }>;
    respond(process, {
      id: resumeId,
      result: threadResumeResult("thread-injected", { type: "idle" })
    });
    await resume;

    const start = client.startTurn("thread-injected", "continue");
    const [{ id: startId }] = messagesFrom(process) as Array<{ id: number }>;
    respond(process, { id: startId, result: turnStartResult() });
    await start;
    await client.close();

    const records = readRpcAudit(auditFile);
    expect(records.filter((record) => record.method === "initialize")).toHaveLength(1);
    expect(records.filter((record) => record.method === "thread/resume")).toEqual([
      expect.objectContaining({ threadId: "thread-injected" })
    ]);
    expect(records.filter((record) => record.method === "turn/start")).toEqual([
      expect.objectContaining({ threadId: "thread-injected" })
    ]);
  });

  it("times out a silent JSON-RPC request and releases the child resources", async () => {
    vi.useFakeTimers();
    process = new FakeAppServerProcess();
    spawnMock.mockReturnValue(process);
    const client = createCodexAppServerClient({ requestTimeoutMs: 100 });

    const initialization = client.initialize();
    const rejected = expect(initialization).rejects.toMatchObject({ code: "codex_app_server_unavailable" });
    expect(messagesFrom(process)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);

    await rejected;
    await expect(client.close()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(process.stdin.destroyed).toBe(true);
    expect(process.stdout.destroyed).toBe(true);
    expect(process.stderr.destroyed).toBe(true);
    expect(process.listenerCount("exit")).toBe(0);
  });

  it.each(["thread/resume", "turn/start"] as const)(
    "bounds a silent %s request with the same per-request deadline",
    async (method) => {
      vi.useFakeTimers();
      const client = createCodexAppServerClient({ requestTimeoutMs: 100 });
      const initialization = client.initialize();
      const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
      respond(process, { id, result: initializeResult });
      await initialization;
      messagesFrom(process);

      const request = method === "thread/resume"
        ? client.resumeThread("thread-1")
        : client.startTurn("thread-1", "continue");
      const rejected = expect(request).rejects.toMatchObject({ code: "codex_app_server_unavailable" });
      await vi.advanceTimersByTimeAsync(100);

      await rejected;
      await expect(client.close()).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      expect(process.stdin.destroyed).toBe(true);
      expect(process.stdout.destroyed).toBe(true);
      expect(process.stderr.destroyed).toBe(true);
      expect(process.listenerCount("exit")).toBe(0);
    }
  );

  it("aborts a silent request immediately when delivery ownership is lost", async () => {
    const controller = new AbortController();
    const client = createCodexAppServerClient({ requestTimeoutMs: 10_000 });
    const initialization = client.initialize(controller.signal);
    const rejected = expect(initialization).rejects.toMatchObject({ code: "codex_app_server_unavailable" });
    messagesFrom(process);

    controller.abort();

    await rejected;
    await expect(client.close()).resolves.toBeUndefined();
    expect(process.stdin.destroyed).toBe(true);
    expect(process.stdout.destroyed).toBe(true);
    expect(process.stderr.destroyed).toBe(true);
    expect(process.listenerCount("exit")).toBe(0);
  });

  it("waits for initialize response before sending initialized", async () => {
    const client = createCodexAppServerClient();
    const initialization = client.initialize();

    expect(messagesFrom(process)).toHaveLength(1);
    await Promise.resolve();
    expect(messagesFrom(process)).toEqual([]);

    respond(process, { id: 1, result: initializeResult });
    await initialization;
    expect(messagesFrom(process)).toEqual([{ method: "initialized", params: {} }]);
    await client.close();
  });

  it("coalesces concurrent initialize calls into one handshake", async () => {
    const client = createCodexAppServerClient();
    const first = client.initialize();
    const second = client.initialize();

    expect(messagesFrom(process)).toHaveLength(1);
    respond(process, { id: 1, result: initializeResult });

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(messagesFrom(process)).toEqual([{ method: "initialized", params: {} }]);
    await client.close();
  });

  it("rejects an initialize response missing installed-schema required fields", async () => {
    const client = createCodexAppServerClient();
    const initialization = client.initialize();
    messagesFrom(process);

    respond(process, { id: 1, result: { userAgent: "codex-cli/0.144.2" } });

    await expect(initialization).rejects.toMatchObject({ code: "codex_app_server_incompatible" });
    expect(messagesFrom(process)).toEqual([]);
    await client.close();
  });

  it("uses numeric request ids and resolves concurrent pending requests by id", async () => {
    const client = await initializeClient(process);

    const resume = client.resumeThread("thread-1");
    const start = client.startTurn("thread-1", "continue");
    expect(messagesFrom(process)).toEqual([
      { method: "thread/resume", id: 2, params: { threadId: "thread-1" } },
      {
        method: "turn/start",
        id: 3,
        params: {
          threadId: "thread-1",
          input: [{ type: "text", text: "continue" }]
        }
      }
    ]);

    respond(process, { id: 3, result: turnStartResult() });
    respond(process, { id: 2, result: threadResumeResult("thread-1", { type: "idle" }) });

    await expect(start).resolves.toBeUndefined();
    await expect(resume).resolves.toEqual({ exists: true, busy: false });
    await client.close();
  });

  it("ignores valid notifications without disturbing pending requests", async () => {
    const client = await initializeClient(process);

    const resume = client.resumeThread("thread-1");
    const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
    process.stdout.write(`${JSON.stringify({ method: "thread/status/changed", params: {} })}\n`);
    respond(process, { id, result: threadResumeResult("thread-1", { type: "idle" }) });

    await expect(resume).resolves.toEqual({ exists: true, busy: false });
    await client.close();
  });

  it("rejects a notification-shaped frame that also carries a response member", async () => {
    const client = await initializeClient(process);
    const resume = client.resumeThread("thread-1");
    messagesFrom(process);
    void resume.catch(() => undefined);

    respond(process, {
      method: "thread/status/changed",
      params: {},
      result: { private: "detail" }
    });
    await Promise.resolve();
    process.exit(17);

    await expect(resume).rejects.toMatchObject({ code: "codex_app_server_incompatible" });
    await client.close();
  });

  it("turns malformed JSONL into a terminal protocol failure for every pending request", async () => {
    const client = await initializeClient(process);
    const resume = client.resumeThread("thread-1");
    const start = client.startTurn("thread-1", "continue");
    messagesFrom(process);
    void resume.catch(() => undefined);
    void start.catch(() => undefined);

    process.stdout.write("not-json\n");
    await Promise.resolve();
    process.exit(17);

    await expect(resume).rejects.toMatchObject({ code: "codex_app_server_incompatible" });
    await expect(start).rejects.toMatchObject({ code: "codex_app_server_incompatible" });
    await expect(client.resumeThread("thread-1")).rejects.toMatchObject({ code: "codex_app_server_incompatible" });
    await client.close();
  });

  it.each([
    ["missing result and error", (id: number) => ({ id })],
    ["both result and error", (id: number) => ({
      id,
      result: threadResumeResult("thread-1", { type: "idle" }),
      error: { code: -32600, message: "private conflict" }
    })],
    ["malformed error", (id: number) => ({
      id,
      error: { code: "-32600", message: 17 }
    })]
  ] as const)("makes a matching response with %s a terminal protocol failure", async (_name, frame) => {
    const client = await initializeClient(process);
    const resume = client.resumeThread("thread-1");
    const [{ id }] = messagesFrom(process) as Array<{ id: number }>;

    respond(process, frame(id));
    await expect(resume).rejects.toMatchObject({ code: "codex_app_server_incompatible" });

    const future = client.resumeThread("thread-1");
    void future.catch(() => undefined);
    process.exit(17);
    await expect(future).rejects.toMatchObject({ code: "codex_app_server_incompatible" });
    await client.close();
  });

  it("rejects a thread/resume result missing installed-schema required fields", async () => {
    const client = await initializeClient(process);
    const resume = client.resumeThread("thread-1");
    const [{ id }] = messagesFrom(process) as Array<{ id: number }>;

    respond(process, {
      id,
      result: { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } }
    });

    await expect(resume).rejects.toMatchObject({ code: "codex_app_server_incompatible" });
    await client.close();
  });

  it("rejects a turn/start result missing the required turn fields", async () => {
    const client = await initializeClient(process);
    const start = client.startTurn("thread-1", "continue");
    const [{ id }] = messagesFrom(process) as Array<{ id: number }>;

    respond(process, { id, result: { turn: { id: "turn-1" } } });

    await expect(start).rejects.toMatchObject({ code: "codex_app_server_incompatible" });
    await client.close();
  });

  it("returns an already terminal turn without waiting for a notification", async () => {
    const client = await initializeClient(process);
    const completed = client.startTurnAndWait("thread-1", "continue");
    const [{ id }] = messagesFrom(process) as Array<{ id: number }>;

    respond(process, { id, result: turnStartResult("turn-terminal", "completed") });

    await expect(completed).resolves.toEqual({
      turnId: "turn-terminal",
      status: "completed"
    });
    await client.close();
  });

  it("decodes the installed thread status union", async () => {
    const client = await initializeClient(process);

    const active = client.resumeThread("thread-active");
    const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
    respond(process, {
      id,
      result: threadResumeResult(
        "thread-active",
        { type: "active", activeFlags: ["waitingOnApproval"] }
      )
    });
    await expect(active).resolves.toEqual({ exists: true, busy: true });
    await client.close();
  });

  it("retries a not-loaded thread instead of starting a turn", async () => {
    const client = await initializeClient(process);

    const resume = client.resumeThread("thread-not-loaded");
    const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
    respond(process, {
      id,
      result: threadResumeResult("thread-not-loaded", { type: "notLoaded" })
    });

    await expect(resume).resolves.toEqual({ exists: true, busy: true });
    await client.close();
  });

  it("rejects a system-error thread status as retryable protocol failure", async () => {
    const client = await initializeClient(process);

    const resume = client.resumeThread("thread-error");
    const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
    respond(process, {
      id,
      result: threadResumeResult("thread-error", { type: "systemError" })
    });

    await expect(resume).rejects.toMatchObject({ code: "codex_app_server_incompatible" });
    await client.close();
  });

  it("decodes a missing thread RPC error as exists false", async () => {
    const client = await initializeClient(process);

    const resume = client.resumeThread("missing-thread");
    const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
    respond(process, {
      id,
      error: { code: -32600, message: "no rollout found for thread id missing-thread" }
    });

    await expect(resume).resolves.toEqual({ exists: false, busy: false });
    await client.close();
  });

  it.each([
    "Forbidden",
    "permission denied",
    "access denied",
    "unauthorized"
  ])("classifies a forbidden thread RPC error without exposing its message (%s)", async (message) => {
    const client = await initializeClient(process);

    const resume = client.resumeThread("thread-1");
    const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
    respond(process, { id, error: { code: -32600, message: `${message}: private detail` } });

    await expect(resume).rejects.toMatchObject({
      name: "CodexAppServerError",
      code: "codex_thread_forbidden",
      message: "Codex thread is forbidden"
    });
    await client.close();
  });

  it("rejects every pending request when the process exits", async () => {
    const client = await initializeClient(process);
    const resume = client.resumeThread("thread-1");
    const start = client.startTurn("thread-1", "continue");
    messagesFrom(process);

    process.exit(17);

    await expect(resume).rejects.toMatchObject({ code: "codex_app_server_unavailable" });
    await expect(start).rejects.toMatchObject({ code: "codex_app_server_unavailable" });
    await expect(client.resumeThread("thread-1")).rejects.toMatchObject({ code: "codex_app_server_unavailable" });
    await client.close();
    expect(process.killCalls).toBe(0);
  });

  it("rejects every pending request when the process emits an error", async () => {
    const client = createCodexAppServerClient();
    const initialization = client.initialize();
    messagesFrom(process);

    process.emit("error", new Error("spawn private detail"));

    await expect(initialization).rejects.toMatchObject({
      code: "codex_app_server_unavailable",
      message: "Codex App Server request failed"
    });
    await expect(client.resumeThread("thread-1")).rejects.toMatchObject({ code: "codex_app_server_unavailable" });
    await client.close();
    expect(process.stdin.writableEnded).toBe(true);
    expect(process.killCalls).toBe(0);
  });

  it.each(["stdin", "stdout", "stderr"] as const)(
    "rejects every pending request when %s emits an error",
    async (stream) => {
      const client = await initializeClient(process);
      const resume = client.resumeThread("thread-1");
      messagesFrom(process);

      process[stream].emit("error", new Error("private stream detail"));

      await expect(resume).rejects.toMatchObject({ code: "codex_app_server_unavailable" });
      await client.close();
      expect(process.stdin.writableEnded).toBe(true);
      expect(process.killCalls).toBe(0);
    }
  );

  it("makes close idempotent", async () => {
    const client = createCodexAppServerClient();

    await Promise.all([client.close(), client.close(), client.close()]);

    expect(process.exitCode).toBe(0);
    expect(process.killCalls).toBe(0);
    expect(process.listenerCount("error")).toBe(0);
    expect(process.stdin.listenerCount("error")).toBe(0);
    expect(process.stdout.listenerCount("error")).toBe(0);
    expect(process.stderr.listenerCount("error")).toBe(0);
  });

  it.each(["child", "stdin", "stdout", "stderr"] as const)(
    "keeps every error guard installed while teardown from %s error is pending",
    async (source) => {
      vi.useFakeTimers();
      process = new FakeAppServerProcess(false, null);
      spawnMock.mockReturnValue(process);
      const client = await initializeClient(process);
      const resume = client.resumeThread("thread-1");
      messagesFrom(process);
      void resume.catch(() => undefined);

      const emitter = source === "child" ? process : process[source];
      emitter.emit("error", new Error("first private transport detail"));
      const teardown = client.close();
      const pendingError = await resume.catch((error: unknown) => error);
      expect(pendingError).toMatchObject({ code: "codex_app_server_unavailable" });

      const expectErrorsGuarded = () => {
        const kills = [...process.killSignals];
        expect(() => process.emit("error", new Error("second child detail"))).not.toThrow();
        expect(() => process.stdin.emit("error", new Error("second stdin detail"))).not.toThrow();
        expect(() => process.stdout.emit("error", new Error("second stdout detail"))).not.toThrow();
        expect(() => process.stderr.emit("error", new Error("second stderr detail"))).not.toThrow();
        expect(client.close()).toBe(teardown);
        expect(process.killSignals).toEqual(kills);
      };

      expectErrorsGuarded();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(process.killSignals).toEqual(["SIGTERM"]);
      expectErrorsGuarded();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      expectErrorsGuarded();
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(teardown).resolves.toBeUndefined();
      expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(process.listenerCount("error")).toBe(1);
      expect(process.stdin.listenerCount("error")).toBe(1);
      expect(process.stdout.listenerCount("error")).toBe(1);
      expect(process.stderr.listenerCount("error")).toBe(1);
      expect(await resume.catch((error: unknown) => error)).toBe(pendingError);
      expect(await client.resumeThread("thread-1").catch((error: unknown) => error)).toBe(pendingError);
    }
  );

  it("escalates from SIGTERM to SIGKILL when EOF and SIGTERM do not stop the child", async () => {
    vi.useFakeTimers();
    process = new FakeAppServerProcess(false, "SIGKILL");
    spawnMock.mockReturnValue(process);
    const client = createCodexAppServerClient();

    const closing = client.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    const closedWithinBound = closed;
    if (!closed) process.exit(0);

    await expect(closing).resolves.toBeUndefined();
    expect(closedWithinBound).toBe(true);
    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("releases every resource after bounded waits when SIGKILL does not produce exit", async () => {
    vi.useFakeTimers();
    process = new FakeAppServerProcess(false, null);
    spawnMock.mockReturnValue(process);
    const client = createCodexAppServerClient();

    const closing = client.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    const closedWithinBound = closed;
    if (!closed) process.exit(0);

    await expect(closing).resolves.toBeUndefined();
    expect(closedWithinBound).toBe(true);
    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(process.stdin.destroyed).toBe(true);
    expect(process.stdout.destroyed).toBe(true);
    expect(process.stderr.destroyed).toBe(true);
    expect(process.listenerCount("error")).toBe(1);
    expect(process.listenerCount("exit")).toBe(0);
    expect(process.stdin.listenerCount("error")).toBe(1);
    expect(process.stdout.listenerCount("error")).toBe(1);
    expect(process.stderr.listenerCount("error")).toBe(1);
    expect(process.unrefCalls).toBe(1);

    const kills = [...process.killSignals];
    expect(() => process.emit("error", new Error("late child error"))).not.toThrow();
    expect(() => process.stdin.emit("error", new Error("late stdin error"))).not.toThrow();
    expect(() => process.stdout.emit("error", new Error("late stdout error"))).not.toThrow();
    expect(() => process.stderr.emit("error", new Error("late stderr error"))).not.toThrow();
    expect(client.close()).toBe(closing);
    expect(process.killSignals).toEqual(kills);
    expect(process.unrefCalls).toBe(1);
    expect(process.listenerCount("error")).toBe(1);
    expect(process.stdin.listenerCount("error")).toBe(1);
    expect(process.stdout.listenerCount("error")).toBe(1);
    expect(process.stderr.listenerCount("error")).toBe(1);
  });

  it("starts one teardown immediately on stream error without waiting for explicit close", async () => {
    vi.useFakeTimers();
    process = new FakeAppServerProcess(false, "SIGKILL");
    spawnMock.mockReturnValue(process);
    const client = await initializeClient(process);
    const resume = client.resumeThread("thread-1");
    messagesFrom(process);
    void resume.catch(() => undefined);

    process.stderr.emit("error", new Error("private stream detail"));
    expect(process.stdin.writableEnded).toBe(true);
    const firstClose = client.close();
    const secondClose = client.close();
    expect(secondClose).toBe(firstClose);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(resume).rejects.toMatchObject({ code: "codex_app_server_unavailable" });
    await expect(firstClose).resolves.toBeUndefined();
    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("starts teardown immediately on malformed JSONL without explicit close", async () => {
    vi.useFakeTimers();
    process = new FakeAppServerProcess(false, null);
    spawnMock.mockReturnValue(process);
    const client = await initializeClient(process);
    const resume = client.resumeThread("thread-1");
    messagesFrom(process);
    void resume.catch(() => undefined);

    process.stdout.write("not-json\n");
    expect(process.stdin.writableEnded).toBe(true);
    const teardown = client.close();
    await vi.advanceTimersByTimeAsync(5_000);

    const pendingError = await resume.catch((error: unknown) => error);
    expect(pendingError).toMatchObject({ code: "codex_app_server_incompatible" });
    await expect(teardown).resolves.toBeUndefined();
    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);

    expect(() => process.emit("error", new Error("late child private detail"))).not.toThrow();
    expect(() => process.stdin.emit("error", new Error("late stdin private detail"))).not.toThrow();
    expect(() => process.stdout.emit("error", new Error("late stdout private detail"))).not.toThrow();
    expect(() => process.stderr.emit("error", new Error("late stderr private detail"))).not.toThrow();
    expect(client.close()).toBe(teardown);
    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(process.unrefCalls).toBe(1);
    expect(await resume.catch((error: unknown) => error)).toBe(pendingError);
    expect(await client.resumeThread("thread-1").catch((error: unknown) => error)).toBe(pendingError);
  });

  it.each([
    ["ENOENT", "codex_cli_not_found"],
    ["EPERM", "codex_cli_not_executable"],
    ["EACCES", "codex_cli_not_executable"]
  ] as const)("classifies spawn %s as permanent %s", async (osCode, errorCode) => {
    const spawnError = Object.assign(new Error("private path"), { code: osCode });
    spawnMock.mockImplementationOnce(() => { throw spawnError; });

    let caught: unknown;
    try {
      createCodexAppServerClient({ spawnProcess: spawnMock });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: errorCode });
    expect((caught as Error).message).not.toContain("private path");
    expect(classifyCodexError(caught)).toEqual({
      outcome: "permanent",
      error: "Codex App Server executable is unavailable",
      errorCode
    });
  });

  it("classifies an asynchronous child error carrying EPERM as permanent", async () => {
    const client = createCodexAppServerClient();
    const initialization = client.initialize();
    messagesFrom(process);

    process.emit("error", Object.assign(new Error("private path"), { code: "EPERM" }));

    await expect(initialization).rejects.toMatchObject({ code: "codex_cli_not_executable" });
    expect(classifyCodexError(await initialization.catch((error: unknown) => error))).toEqual({
      outcome: "permanent",
      error: "Codex App Server executable is unavailable",
      errorCode: "codex_cli_not_executable"
    });
    await client.close();
  });
});
