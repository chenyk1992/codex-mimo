import fs from "node:fs";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CALLBACK_HEADER,
  buildCallbackSummary,
  createHookCallbackController,
  createInvocationId,
  toExecutionCallbackEvidence,
  writeHookConfig
} from "../../src/mimo/hook-callback.js";

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-hook-callback-"));
  tempDirs.push(cwd);
  return cwd;
}

function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("hook callback payload helpers", () => {
  it("creates deterministic invocation ids from kind, timestamp, and random suffix", () => {
    expect(createInvocationId("implement", () => 1768040303616, () => "abc123")).toBe("implement-mk85jpc0-abc123");
  });

  it("sanitizes invocation id prefixes", () => {
    expect(createInvocationId("  compose:dev / plan  ", () => 1768040303616, () => "abc123")).toBe(
      "compose-dev-plan-mk85jpc0-abc123"
    );
    expect(createInvocationId("?!", () => 1768040303616, () => "abc123")).toBe("mimo-mk85jpc0-abc123");
  });

  it("normalizes session.post payloads into compact summaries", () => {
    const summary = buildCallbackSummary({
      invocationId: "implement-mk85jpc0-abc123",
      event: "session.post",
      timestamp: "2026-06-26T00:00:00.000Z",
      sessionID: "session-1",
      agentID: "agent-1",
      task_id: "task-1",
      outcome: "completed",
      error: "failed",
      finalText: "Implementation complete",
      assistantMessageID: "message-1",
      metadata: { trajectoryLength: 12 }
    });

    expect(summary).toEqual({
      invocationId: "implement-mk85jpc0-abc123",
      event: "session.post",
      receivedAt: "2026-06-26T00:00:00.000Z",
      sessionId: "session-1",
      agentId: "agent-1",
      taskId: "task-1",
      outcome: "completed",
      error: "failed",
      finalText: "Implementation complete",
      assistantMessageId: "message-1",
      trajectoryLength: 12
    });
  });

  it("separates transient callback text from stored execution callback metadata", () => {
    const evidence = toExecutionCallbackEvidence("fallback-invocation", {
      invocationId: "hook-invocation",
      event: "session.post",
      receivedAt: "2026-07-16T00:00:00.000Z",
      sessionId: "ses-1",
      outcome: "completed",
      finalText: "Completed from callback with private-token."
    });

    expect(evidence).toEqual({
      executionCallback: {
        invocationId: "hook-invocation",
        receivedAt: "2026-07-16T00:00:00.000Z",
        sessionId: "ses-1",
        outcome: "completed"
      },
      callbackFinalText: "Completed from callback with private-token."
    });
    expect(JSON.stringify(evidence.executionCallback)).not.toContain("private-token");
  });

  it("records a missing execution callback without changing wire identifiers", () => {
    expect(toExecutionCallbackEvidence("fallback-invocation", null)).toEqual({
      executionCallback: {
        invocationId: "fallback-invocation",
        outcome: "missing",
        error: "MiMoCode exited before codex-mimo received session.post."
      }
    });
    expect(CALLBACK_HEADER).toBe("x-codex-mimo-callback-token");
  });

  it("writes a callable MiMoCode plugin under a runtime config directory", () => {
    const cwd = tempWorkspace();
    const paths = writeHookConfig({
      cwd,
      invocationId: "implement-mk85jpc0-abc123",
      endpoint: "http://127.0.0.1:12345/mimo-hook",
      token: "secret-token"
    });

    expect(paths.configDir).toBe(path.join(cwd, ".codex-mimo", "runtime-hooks", "implement-mk85jpc0-abc123"));
    expect(paths.pluginDir).toBe(path.join(paths.configDir, "plugin"));
    expect(paths.hookFile).toBe(path.join(paths.pluginDir, "codex-mimo-callback.js"));
    expect(fs.existsSync(paths.hookFile)).toBe(true);

    const source = fs.readFileSync(paths.hookFile, "utf-8");
    expect(source).toContain("export default async function codexMimoCallbackPlugin()");
    expect(source).toContain("return {");
    expect(source).toContain("\"session.post\"");
    expect(source).toContain(CALLBACK_HEADER);
    expect(source).toContain("Array.isArray(input.trajectory)");
    expect(source).not.toContain("export default {");
  });
});

describe("hook callback controller", () => {
  it("closes the callback server if hook config writing fails", async () => {
    const cwd = tempWorkspace();
    let callbackPort = 0;

    await expect(
      createHookCallbackController(
        {
          cwd,
          kind: "implement",
          callbackWaitMs: 1000,
          now: () => 1782496000000,
          random: () => "cfgfail"
        },
        {
          writeHookConfig: (input) => {
            callbackPort = new URL(input.endpoint).port ? Number(new URL(input.endpoint).port) : 0;
            throw new Error("config write failed");
          }
        }
      )
    ).rejects.toThrow("config write failed");

    expect(callbackPort).toBeGreaterThan(0);
    await expect(canBindPort(callbackPort)).resolves.toBe(true);
  });

  it("resolves only matching authenticated session.post callbacks", async () => {
    const cwd = tempWorkspace();
    const controller = await createHookCallbackController({
      cwd,
      kind: "implement",
      callbackWaitMs: 1000,
      now: () => 1782496000000,
      random: () => "abc123"
    });

    try {
      const bad = await fetch(controller.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", [CALLBACK_HEADER]: "wrong" },
        body: JSON.stringify({ invocationId: controller.invocationId, event: "session.post" })
      });
      expect(bad.status).toBe(401);

      const wrongInvocation = await fetch(controller.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", [CALLBACK_HEADER]: controller.token },
        body: JSON.stringify({ invocationId: "other-invocation", event: "session.post" })
      });
      expect(wrongInvocation.status).toBe(409);

      const wrongEvent = await fetch(controller.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", [CALLBACK_HEADER]: controller.token },
        body: JSON.stringify({ invocationId: controller.invocationId, event: "session.pre" })
      });
      expect(wrongEvent.status).toBe(409);

      const good = await fetch(controller.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", [CALLBACK_HEADER]: controller.token },
        body: JSON.stringify({
          invocationId: controller.invocationId,
          event: "session.post",
          timestamp: "2026-06-27T01:00:00.000Z",
          sessionID: "ses_good",
          agentID: "main",
          outcome: "completed",
          finalText: "done"
        })
      });
      expect(good.status).toBe(200);

      await expect(controller.waitForCallback()).resolves.toMatchObject({
        sessionId: "ses_good",
        outcome: "completed",
        finalText: "done"
      });
    } finally {
      await controller.close();
    }
  });

  it("times out with null when no callback arrives", async () => {
    const cwd = tempWorkspace();
    const controller = await createHookCallbackController({
      cwd,
      kind: "plan",
      callbackWaitMs: 5,
      now: () => 1782496000000,
      random: () => "def456"
    });

    try {
      await expect(controller.waitForCallback()).resolves.toBeNull();
    } finally {
      await controller.close();
    }
  });

  it("does not start the callback timeout before waitForCallback is called", async () => {
    const cwd = tempWorkspace();
    const controller = await createHookCallbackController({
      cwd,
      kind: "plan",
      callbackWaitMs: 5,
      now: () => 1782496000000,
      random: () => "lazy01"
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 25));

      const valid = await fetch(controller.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", [CALLBACK_HEADER]: controller.token },
        body: JSON.stringify({
          invocationId: controller.invocationId,
          event: "session.post",
          timestamp: "2026-06-27T01:00:00.000Z",
          sessionID: "ses_late_wait",
          outcome: "completed",
          finalText: "arrived before wait"
        })
      });
      expect(valid.status).toBe(200);

      await expect(controller.waitForCallback()).resolves.toMatchObject({
        sessionId: "ses_late_wait",
        outcome: "completed",
        finalText: "arrived before wait"
      });
    } finally {
      await controller.close();
    }
  });

  it("rejects malformed authenticated callbacks without resolving before a later valid callback", async () => {
    const cwd = tempWorkspace();
    const controller = await createHookCallbackController({
      cwd,
      kind: "implement",
      callbackWaitMs: 1000,
      now: () => 1768040303616,
      random: () => "bad001"
    });

    try {
      const malformed = await fetch(controller.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", [CALLBACK_HEADER]: controller.token },
        body: JSON.stringify({
          invocationId: controller.invocationId,
          event: "session.post",
          timestamp: "",
          sessionID: "ses_bad",
          outcome: "completed"
        })
      });
      expect(malformed.status).toBe(400);

      const valid = await fetch(controller.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", [CALLBACK_HEADER]: controller.token },
        body: JSON.stringify({
          invocationId: controller.invocationId,
          event: "session.post",
          timestamp: "2026-06-27T01:00:00.000Z",
          sessionID: "ses_valid",
          outcome: "completed",
          finalText: "valid"
        })
      });
      expect(valid.status).toBe(200);

      await expect(controller.waitForCallback()).resolves.toMatchObject({
        sessionId: "ses_valid",
        finalText: "valid"
      });
    } finally {
      await controller.close();
    }
  });

  it("persists the accepted callback payload for debugging", async () => {
    const cwd = tempWorkspace();
    const controller = await createHookCallbackController({
      cwd,
      kind: "review",
      callbackWaitMs: 1000,
      now: () => 1782496000000,
      random: () => "fedcba"
    });

    try {
      await fetch(controller.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", [CALLBACK_HEADER]: controller.token },
        body: JSON.stringify({
          invocationId: controller.invocationId,
          event: "session.post",
          timestamp: "2026-06-27T01:00:00.000Z",
          sessionID: "ses_persist",
          outcome: "cancelled",
          error: "blocked",
          finalText: "transient-private-token"
        })
      });

      await controller.waitForCallback();
      expect(fs.existsSync(controller.callbackFile)).toBe(true);
      const persisted = fs.readFileSync(controller.callbackFile, "utf-8");
      expect(persisted).toContain("ses_persist");
      expect(persisted).not.toContain("transient-private-token");
    } finally {
      await controller.close();
    }
  });

  it("does not overwrite the persisted callback payload for duplicate accepted callbacks", async () => {
    const cwd = tempWorkspace();
    const controller = await createHookCallbackController({
      cwd,
      kind: "review",
      callbackWaitMs: 1000,
      now: () => 1768040303616,
      random: () => "dup001"
    });

    try {
      const first = await fetch(controller.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", [CALLBACK_HEADER]: controller.token },
        body: JSON.stringify({
          invocationId: controller.invocationId,
          event: "session.post",
          timestamp: "2026-06-27T01:00:00.000Z",
          sessionID: "ses_first",
          outcome: "completed",
          finalText: "first"
        })
      });
      expect(first.status).toBe(200);
      await controller.waitForCallback();

      const duplicate = await fetch(controller.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", [CALLBACK_HEADER]: controller.token },
        body: JSON.stringify({
          invocationId: controller.invocationId,
          event: "session.post",
          timestamp: "2026-06-27T01:00:01.000Z",
          sessionID: "ses_second",
          outcome: "completed",
          finalText: "second"
        })
      });
      expect(duplicate.status).toBe(200);

      const persisted = fs.readFileSync(controller.callbackFile, "utf-8");
      expect(persisted).toContain("ses_first");
      expect(persisted).not.toContain("ses_second");
    } finally {
      await controller.close();
    }
  });

  it("settles pending waits with null when closed before a callback arrives", async () => {
    const cwd = tempWorkspace();
    const controller = await createHookCallbackController({
      cwd,
      kind: "plan",
      callbackWaitMs: 1000,
      now: () => 1768040303616,
      random: () => "close1"
    });

    const wait = controller.waitForCallback();
    await controller.close();
    await expect(wait).resolves.toBeNull();
  });

  it("force-closes an active HTTP connection without blocking controller shutdown", async () => {
    const cwd = tempWorkspace();
    const controller = await createHookCallbackController({
      cwd,
      kind: "plan",
      now: () => 1768040303616,
      random: () => "socket1"
    });
    const endpoint = new URL(controller.endpoint);
    const socket = net.createConnection(Number(endpoint.port), endpoint.hostname);
    socket.on("error", () => undefined);
    await once(socket, "connect");
    socket.write("POST /mimo-hook HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const closing = controller.close();

    try {
      const outcome = await Promise.race([
        closing.then(() => "closed" as const),
        new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 150))
      ]);
      expect(outcome).toBe("closed");
      await socketClosed;
    } finally {
      socket.destroy();
      await closing;
    }
  });
});
