import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CALLBACK_HEADER,
  buildCallbackSummary,
  createHookCallbackController,
  createInvocationId,
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

  it("writes a MiMoCode file-hook object under a runtime config directory", () => {
    const cwd = tempWorkspace();
    const paths = writeHookConfig({
      cwd,
      invocationId: "implement-mk85jpc0-abc123",
      endpoint: "http://127.0.0.1:12345/mimo-hook",
      token: "secret-token"
    });

    expect(paths.configDir).toBe(path.join(cwd, ".codex-mimo", "runtime-hooks", "implement-mk85jpc0-abc123"));
    expect(paths.hookDir).toBe(path.join(paths.configDir, "hooks"));
    expect(paths.hookFile).toBe(path.join(paths.hookDir, "codex-mimo-callback.js"));
    expect(fs.existsSync(paths.hookFile)).toBe(true);

    const source = fs.readFileSync(paths.hookFile, "utf-8");
    expect(source).toContain("export default {");
    expect(source).toContain("\"session.post\"");
    expect(source).toContain(CALLBACK_HEADER);
    expect(source).toContain("Array.isArray(input.trajectory)");
    expect(source).not.toContain("export default async");
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
          error: "blocked"
        })
      });

      await controller.waitForCallback();
      expect(fs.existsSync(controller.callbackFile)).toBe(true);
      expect(fs.readFileSync(controller.callbackFile, "utf-8")).toContain("ses_persist");
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
});
