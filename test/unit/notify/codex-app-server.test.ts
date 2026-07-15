import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

  constructor() {
    super();
    this.stdin.once("finish", () => {
      if (this.exitCode === null) this.exit(0);
    });
  }

  exit(code: number | null): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
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
  respond(process, { id: 1, result: { userAgent: "codex-cli/0.144.2" } });
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

    respond(process, { id: 1, result: {} });
    await initialization;
    expect(messagesFrom(process)).toEqual([{ method: "initialized", params: {} }]);
    await client.close();
  });

  it("coalesces concurrent initialize calls into one handshake", async () => {
    const client = createCodexAppServerClient();
    const first = client.initialize();
    const second = client.initialize();

    expect(messagesFrom(process)).toHaveLength(1);
    respond(process, { id: 1, result: {} });

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(messagesFrom(process)).toEqual([{ method: "initialized", params: {} }]);
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

    respond(process, { id: 3, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    respond(process, {
      id: 2,
      result: { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } }
    });

    await expect(start).resolves.toBeUndefined();
    await expect(resume).resolves.toEqual({ exists: true, busy: false });
    await client.close();
  });

  it("ignores non-response JSONL without disturbing pending requests", async () => {
    const client = await initializeClient(process);

    const resume = client.resumeThread("thread-1");
    const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
    process.stdout.write("null\n");
    process.stdout.write(`${JSON.stringify({ method: "thread/status/changed", params: {} })}\n`);
    respond(process, {
      id,
      result: { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } }
    });

    await expect(resume).resolves.toEqual({ exists: true, busy: false });
    await client.close();
  });

  it("decodes the installed thread status union", async () => {
    const client = await initializeClient(process);

    const active = client.resumeThread("thread-active");
    const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
    respond(process, {
      id,
      result: {
        thread: {
          id: "thread-active",
          status: { type: "active", activeFlags: ["waitingOnApproval"] },
          turns: []
        }
      }
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
      result: {
        thread: { id: "thread-not-loaded", status: { type: "notLoaded" }, turns: [] }
      }
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
      result: { thread: { id: "thread-error", status: { type: "systemError" }, turns: [] } }
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
    }
  );

  it("makes close idempotent", async () => {
    const client = createCodexAppServerClient();

    await Promise.all([client.close(), client.close(), client.close()]);

    expect(process.exitCode).toBe(0);
  });
});
