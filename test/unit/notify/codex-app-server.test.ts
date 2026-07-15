import { EventEmitter } from "node:events";
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

function turnStartResult(id = "turn-1"): Record<string, unknown> {
  return { turn: { id, status: "inProgress", items: [] } };
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

describe("Codex App Server client", () => {
  let process: FakeAppServerProcess;

  beforeEach(() => {
    process = new FakeAppServerProcess();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(process);
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(process.stderr.readableFlowing).toBe(true);
    await client.close();
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

    await expect(initialization).rejects.toMatchObject({ kind: "protocol" });
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

    await expect(resume).rejects.toMatchObject({ kind: "protocol" });
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

    await expect(resume).rejects.toMatchObject({ kind: "protocol" });
    await expect(start).rejects.toMatchObject({ kind: "protocol" });
    await expect(client.resumeThread("thread-1")).rejects.toMatchObject({ kind: "protocol" });
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
    await expect(resume).rejects.toMatchObject({ kind: "protocol" });

    const future = client.resumeThread("thread-1");
    void future.catch(() => undefined);
    process.exit(17);
    await expect(future).rejects.toMatchObject({ kind: "protocol" });
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

    await expect(resume).rejects.toMatchObject({ kind: "protocol" });
    await client.close();
  });

  it("rejects a turn/start result missing the required turn fields", async () => {
    const client = await initializeClient(process);
    const start = client.startTurn("thread-1", "continue");
    const [{ id }] = messagesFrom(process) as Array<{ id: number }>;

    respond(process, { id, result: { turn: { id: "turn-1" } } });

    await expect(start).rejects.toMatchObject({ kind: "protocol" });
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

    await expect(resume).rejects.toMatchObject({ kind: "protocol" });
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
      kind: "forbidden",
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

    await expect(resume).rejects.toMatchObject({ kind: "transport" });
    await expect(start).rejects.toMatchObject({ kind: "transport" });
    await expect(client.resumeThread("thread-1")).rejects.toMatchObject({ kind: "transport" });
    await client.close();
    expect(process.killCalls).toBe(0);
  });

  it("rejects every pending request when the process emits an error", async () => {
    const client = createCodexAppServerClient();
    const initialization = client.initialize();
    messagesFrom(process);

    process.emit("error", new Error("spawn private detail"));

    await expect(initialization).rejects.toEqual(
      new CodexAppServerError("transport", "Codex App Server transport failed")
    );
    await expect(client.resumeThread("thread-1")).rejects.toMatchObject({ kind: "transport" });
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

      await expect(resume).rejects.toMatchObject({ kind: "transport" });
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
  });

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
    expect(process.listenerCount("error")).toBe(0);
    expect(process.listenerCount("exit")).toBe(0);
    expect(process.stdin.listenerCount("error")).toBe(0);
    expect(process.stdout.listenerCount("error")).toBe(0);
    expect(process.stderr.listenerCount("error")).toBe(0);
    expect(process.unrefCalls).toBe(1);
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

    await expect(resume).rejects.toMatchObject({ kind: "transport" });
    await expect(firstClose).resolves.toBeUndefined();
    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("starts teardown immediately on malformed JSONL without explicit close", async () => {
    vi.useFakeTimers();
    process = new FakeAppServerProcess(false, "SIGKILL");
    spawnMock.mockReturnValue(process);
    const client = await initializeClient(process);
    const resume = client.resumeThread("thread-1");
    messagesFrom(process);
    void resume.catch(() => undefined);

    process.stdout.write("not-json\n");
    expect(process.stdin.writableEnded).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(resume).rejects.toMatchObject({ kind: "protocol" });
    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
