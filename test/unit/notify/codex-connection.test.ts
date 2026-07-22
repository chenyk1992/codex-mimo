import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerError,
  type CodexAppServerClient
} from "../../../src/notify/codex-app-server.js";
import { prepareCodexConnection } from "../../../src/notify/codex-connection.js";

function client(overrides: Partial<CodexAppServerClient> = {}): CodexAppServerClient {
  return {
    initialize: vi.fn(async () => undefined),
    resumeThread: vi.fn(async () => ({ exists: true, busy: false })),
    startTurnAndWait: vi.fn(async () => ({
      turnId: "turn-1",
      status: "completed" as const
    })),
    close: vi.fn(async () => undefined),
    ...overrides
  };
}

describe("Codex connection preparation", () => {
  it("keeps a client only after version, initialize, and resume succeed", async () => {
    const preparedClient = Object.assign(client(), {
      privateCommand: "C:\\private\\codex.exe"
    });
    const execute = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "codex 1.2\n" });
    const createClient = vi.fn(() => preparedClient);

    const result = await prepareCodexConnection({
      threadId: "task-1",
      candidates: [{ command: "C:\\private\\codex.exe", source: "path" }],
      execute,
      createClient
    });

    expect(result.probe).toEqual({ ok: true, source: "path", version: "codex 1.2" });
    expect(result.client).toBe(preparedClient);
    expect(result.thread).toEqual({ exists: true, busy: false });
    expect(Object.getOwnPropertyDescriptor(result, "thread")?.enumerable).toBe(false);
    expect(execute).toHaveBeenCalledWith(
      "C:\\private\\codex.exe",
      ["--version"],
      expect.objectContaining({ reject: false, timeout: 10_000 })
    );
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      command: { command: "C:\\private\\codex.exe", source: "path" }
    }));
    expect(preparedClient.initialize).toHaveBeenCalledOnce();
    expect(preparedClient.resumeThread).toHaveBeenCalledWith("task-1", undefined);
    expect(preparedClient.close).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("uses the requested timeout for both version probing and App Server requests", async () => {
    const preparedClient = client();
    const execute = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "codex 1.2\n" });
    const createClient = vi.fn(() => preparedClient);

    await prepareCodexConnection({
      threadId: "task-1",
      requestTimeoutMs: 4_321,
      candidates: [{ command: "codex", source: "path" }],
      execute,
      createClient
    });

    expect(execute).toHaveBeenCalledWith(
      "codex",
      ["--version"],
      expect.objectContaining({ reject: false, timeout: 4_321 })
    );
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      requestTimeoutMs: 4_321
    }));
  });

  it("passes the delivery attempt signal to version execution", async () => {
    const controller = new AbortController();
    const execute = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "codex 1.2\n" });

    await prepareCodexConnection({
      threadId: "task-1",
      signal: controller.signal,
      candidates: [{ command: "codex", source: "path" }],
      execute,
      createClient: () => client()
    });

    expect(execute).toHaveBeenCalledWith(
      "codex",
      ["--version"],
      expect.objectContaining({ cancelSignal: controller.signal })
    );
  });

  it("accepts a busy target as ready", async () => {
    const preparedClient = client({
      resumeThread: vi.fn(async () => ({ exists: true, busy: true }))
    });
    const execute = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "codex 1" });

    const result = await prepareCodexConnection({
      threadId: "task-1",
      candidates: [
        { command: "codex-a", source: "path" },
        { command: "codex-b", source: "desktop-local" }
      ],
      execute,
      createClient: () => preparedClient
    });

    expect(result.probe).toEqual({ ok: true, source: "path", version: "codex 1" });
    expect(result.client).toBe(preparedClient);
    expect(result.thread).toEqual({ exists: true, busy: true });
    expect(Object.getOwnPropertyDescriptor(result, "thread")?.enumerable).toBe(false);
    expect(preparedClient.close).not.toHaveBeenCalled();
    expect(preparedClient.resumeThread).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("closes a missing target and stops before later implicit candidates", async () => {
    const rejectedClient = client({
      resumeThread: vi.fn(async () => ({ exists: false, busy: false }))
    });
    const execute = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "codex 1" });

    const result = await prepareCodexConnection({
      threadId: "missing-task",
      candidates: [
        { command: "codex-a", source: "path" },
        { command: "codex-b", source: "desktop-local" }
      ],
      execute,
      createClient: () => rejectedClient
    });

    expect(result).toEqual({
      probe: { ok: false, source: "path", errorCode: "codex_thread_missing" }
    });
    expect(rejectedClient.close).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("closes a forbidden target and stops before later implicit candidates", async () => {
    const rejectedClient = client({
      resumeThread: vi.fn(async () => {
        throw new CodexAppServerError("codex_thread_forbidden", "private denial");
      })
    });
    const execute = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "codex 1" });

    const result = await prepareCodexConnection({
      threadId: "forbidden-task",
      candidates: [
        { command: "codex-a", source: "path" },
        { command: "codex-b", source: "desktop-local" }
      ],
      execute,
      createClient: () => rejectedClient
    });

    expect(result).toEqual({
      probe: { ok: false, source: "path", errorCode: "codex_thread_forbidden" }
    });
    expect(rejectedClient.close).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("closes failed implicit clients and falls through protocol failures", async () => {
    const incompatibleClient = client({
      initialize: vi.fn(async () => {
        throw new CodexAppServerError("codex_app_server_incompatible", "private protocol detail");
      })
    });
    const compatibleClient = client();
    const createClient = vi.fn()
      .mockReturnValueOnce(incompatibleClient)
      .mockReturnValueOnce(compatibleClient);

    const result = await prepareCodexConnection({
      threadId: "task-1",
      candidates: [
        { command: "C:\\private\\first.exe", source: "path" },
        { command: "C:\\private\\second.exe", source: "desktop-local" }
      ],
      execute: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "codex 1" }),
      createClient
    });

    expect(result.probe).toEqual({ ok: true, source: "desktop-local", version: "codex 1" });
    expect(result.client).toBe(compatibleClient);
    expect(incompatibleClient.close).toHaveBeenCalledOnce();
    expect(compatibleClient.close).not.toHaveBeenCalled();
  });

  it("treats configured candidate failures as authoritative and keeps reports safe", async () => {
    const privateCommand = "C:\\private\\configured\\codex.exe";
    const execute = vi.fn().mockRejectedValue(Object.assign(
      new Error(`${privateCommand}: denied`),
      { code: "EPERM" }
    ));

    const result = await prepareCodexConnection({
      threadId: "task-1",
      candidates: [
        { command: privateCommand, source: "configured" },
        { command: "C:\\private\\fallback.exe", source: "desktop-local" }
      ],
      execute,
      createClient: vi.fn()
    });

    expect(result).toEqual({
      probe: { ok: false, source: "configured", errorCode: "codex_cli_not_executable" }
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("denied");
  });
});
