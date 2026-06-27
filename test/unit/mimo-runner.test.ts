import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execa: vi.fn(),
  createHookCallbackController: vi.fn()
}));

vi.mock("execa", () => ({ execa: mocks.execa }));
vi.mock("../../src/mimo/hook-callback.js", () => ({
  createHookCallbackController: mocks.createHookCallbackController
}));

import { parseMimoOutput, runAndCapture } from "../../src/mimo/mimo-runner.js";

beforeEach(() => {
  mocks.execa.mockReset();
  mocks.createHookCallbackController.mockReset();
});

describe("parseMimoOutput", () => {
  it("recognizes sessionId and sessionID variants", () => {
    expect(parseMimoOutput([{ sessionID: "ses_upper" }]).sessionId).toBe("ses_upper");
    expect(parseMimoOutput([{ sessionId: "ses_camel" }]).sessionId).toBe("ses_camel");
  });

  it("captures changed files from write metadata and edit input paths", () => {
    const result = parseMimoOutput([
      {
        type: "tool_use",
        part: {
          tool: "write",
          state: { metadata: { filepath: ".codex-mimo/plugin-smoke/README.md" } }
        }
      },
      {
        type: "tool_use",
        part: {
          tool: "edit",
          state: { input: { filePath: "src/mimo/run-json.ts" } }
        }
      }
    ]);

    expect(result.changedFiles).toEqual([
      ".codex-mimo/plugin-smoke/README.md",
      "src/mimo/run-json.ts"
    ]);
  });

  it("captures top-level path fields on mutating tool parts", () => {
    const result = parseMimoOutput([
      {
        type: "tool_use",
        part: {
          tool: "edit",
          path: "src/codex/tools.ts",
          state: {}
        }
      }
    ]);

    expect(result.changedFiles).toEqual(["src/codex/tools.ts"]);
  });

  it("captures error messages from JSONL error events", () => {
    const result = parseMimoOutput([
      { type: "error", message: "model failed" },
      { type: "error", part: { text: "tool failed" } }
    ]);

    expect(result.errors).toEqual(["model failed", "tool failed"]);
  });

  it("prefers completed callback session and final text", () => {
    const result = parseMimoOutput([
      { sessionId: "ses_jsonl" },
      { type: "text", part: { text: "jsonl result" } }
    ], {
      invocationId: "inv-cb",
      event: "session.post",
      receivedAt: "2026-06-27T00:00:00.000Z",
      sessionId: "ses_cb",
      outcome: "completed",
      finalText: "callback result"
    });

    expect(result.sessionId).toBe("ses_cb");
    expect(result.summary).toBe("callback result");
    expect(result.callback?.outcome).toBe("completed");
    expect(result.exitCode).toBe(0);
  });

  it("marks cancelled callback as a logical failure even with empty JSONL", () => {
    const result = parseMimoOutput([], {
      invocationId: "inv-cancel",
      event: "session.post",
      receivedAt: "2026-06-27T00:00:00.000Z",
      sessionId: "ses_cancel",
      outcome: "cancelled",
      error: "blocked by hook"
    });

    expect(result.exitCode).toBe(1);
    expect(result.errors).toContain("MiMoCode cancelled: blocked by hook");
    expect(result.callback?.outcome).toBe("cancelled");
  });

  it("marks error callback as a logical failure", () => {
    const result = parseMimoOutput([], {
      invocationId: "inv-error",
      event: "session.post",
      receivedAt: "2026-06-27T00:00:00.000Z",
      sessionId: "ses_error",
      outcome: "error",
      error: "hook failed"
    });

    expect(result.exitCode).toBe(1);
    expect(result.errors).toContain("MiMoCode error: hook failed");
    expect(result.callback?.outcome).toBe("error");
  });

  it("parses tool_use with nested part.state for bash commands", () => {
    const result = parseMimoOutput([
      { type: "text", part: { text: "done" } },
      {
        type: "tool_use",
        part: {
          type: "tool",
          tool: "bash",
          state: {
            input: { command: "npm test" },
            metadata: { exit: 0 }
          }
        }
      }
    ]);

    expect(result.summary).toBe("done");
    expect(result.commands).toEqual([{ command: "npm test", exitCode: 0 }]);
  });
});

describe("runAndCapture", () => {
  it("passes hook environment to mimo run and returns completed callback output", async () => {
    const close = vi.fn();
    mocks.createHookCallbackController.mockResolvedValue({
      env: {
        CODEX_MIMO_INVOCATION_ID: "inv-complete",
        CODEX_MIMO_CALLBACK_ENDPOINT: "http://127.0.0.1:1234/mimo-hook",
        CODEX_MIMO_CALLBACK_TOKEN: "token",
        MIMOCODE_CONFIG_DIR: "E:/project/app/.codex-mimo/runtime-hooks/inv-complete"
      },
      waitForCallback: vi.fn().mockResolvedValue({
        invocationId: "inv-complete",
        event: "session.post",
        receivedAt: "2026-06-27T00:00:00.000Z",
        sessionId: "ses_cb_complete",
        outcome: "completed",
        finalText: "callback summary"
      }),
      close
    });
    mocks.execa.mockResolvedValue({
      stdout: "{\"sessionId\":\"ses_jsonl\"}\n",
      stderr: "",
      exitCode: 0
    });

    const result = await runAndCapture({
      cwd: "E:/project/app",
      message: "Objective: Test completed callback."
    });

    expect(mocks.execa).toHaveBeenCalledWith("mimo", expect.any(Array), expect.objectContaining({
      env: expect.objectContaining({ CODEX_MIMO_INVOCATION_ID: "inv-complete" })
    }));
    expect(result.sessionId).toBe("ses_cb_complete");
    expect(result.summary).toBe("callback summary");
    expect(result.callback?.outcome).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(close).toHaveBeenCalled();
  });

  it("accepts a completed callback after the mimo process has already exited", async () => {
    const close = vi.fn();
    mocks.createHookCallbackController.mockResolvedValue({
      env: { CODEX_MIMO_INVOCATION_ID: "inv-delayed" },
      waitForCallback: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return {
          invocationId: "inv-delayed",
          event: "session.post",
          receivedAt: "2026-06-27T00:00:00.000Z",
          sessionId: "ses_delayed",
          outcome: "completed",
          finalText: "delayed callback"
        };
      }),
      close
    });
    mocks.execa.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0
    });

    const result = await runAndCapture({
      cwd: "E:/project/app",
      message: "Objective: Test delayed callback."
    });

    expect(result.sessionId).toBe("ses_delayed");
    expect(result.summary).toBe("delayed callback");
    expect(result.callbackTimedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(close).toHaveBeenCalled();
  });

  it("returns a failed result when the hook callback times out after process success", async () => {
    const close = vi.fn();
    mocks.createHookCallbackController.mockResolvedValue({
      env: { CODEX_MIMO_INVOCATION_ID: "inv-timeout" },
      waitForCallback: vi.fn().mockResolvedValue(null),
      close
    });
    mocks.execa.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0
    });

    const result = await runAndCapture({
      cwd: "E:/project/app",
      message: "Objective: Test callback timeout."
    });

    expect(result.callbackTimedOut).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.errors).toContain("MiMoCode hook callback timed out before session.post was received.");
    expect(close).toHaveBeenCalled();
  });

  it("returns a structured failure when the MiMo process cannot start", async () => {
    const close = vi.fn();
    mocks.createHookCallbackController.mockResolvedValue({
      env: { CODEX_MIMO_INVOCATION_ID: "inv-startup-failed" },
      waitForCallback: vi.fn(),
      close
    });
    mocks.execa.mockRejectedValue(new Error("spawn mimo ENOENT"));

    const result = await runAndCapture({
      cwd: "E:/project/app",
      message: "Objective: Test startup failure."
    });

    expect(result.exitCode).toBe(1);
    expect(result.summary).toBe("MiMoCode failed to start.");
    expect(result.errors).toEqual(["spawn mimo ENOENT"]);
    expect(result.callbackTimedOut).toBe(true);
    expect(close).toHaveBeenCalled();
  });

  it("returns exit 124 when execa reports a timeout", async () => {
    const waitForCallback = vi.fn();
    const close = vi.fn();
    mocks.createHookCallbackController.mockResolvedValue({
      env: { CODEX_MIMO_INVOCATION_ID: "inv-process-timeout" },
      waitForCallback,
      close
    });
    mocks.execa.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: undefined,
      timedOut: true
    });

    const result = await runAndCapture({
      cwd: "E:/project/app",
      message: "Objective: Test process timeout.",
      timeoutMs: 100
    });

    expect(result.exitCode).toBe(124);
    expect(result.errors).toContain("MiMoCode exceeded the configured process timeout.");
    expect(result.callbackTimedOut).toBe(true);
    expect(waitForCallback).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});
