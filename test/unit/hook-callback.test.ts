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
      outcome: "completed"
    });

    expect(summary).toEqual({
      invocationId: "implement-mk85jpc0-abc123",
      event: "session.post",
      receivedAt: "2026-06-26T00:00:00.000Z",
      sessionId: "session-1",
      outcome: "completed"
    });
  });

  it("does not retain callback final text in execution evidence", () => {
    const callback = {
      invocationId: "hook-invocation",
      event: "session.post",
      receivedAt: "2026-07-16T00:00:00.000Z",
      sessionId: "ses-1",
      outcome: "completed",
      finalText: "Completed from callback with private-token."
    } as const;
    const evidence = toExecutionCallbackEvidence("fallback-invocation", callback);

    expect(evidence).toEqual({
      executionCallback: {
        invocationId: "hook-invocation",
        receivedAt: "2026-07-16T00:00:00.000Z",
        sessionId: "ses-1",
        outcome: "completed"
      }
    });
    expect(JSON.stringify(evidence)).not.toContain("private-token");
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

  it("drops only stale unknown scope guards from completed callbacks", () => {
    const completed = toExecutionCallbackEvidence("fallback", {
      invocationId: "hook-invocation",
      event: "session.post",
      receivedAt: "2026-07-16T00:00:00.000Z",
      sessionId: "ses-1",
      outcome: "completed",
      guardFailure: {
        code: "write_scope_violation",
        sessionId: "ses-1",
        path: "unknown"
      }
    });
    const failed = toExecutionCallbackEvidence("fallback", {
      invocationId: "hook-invocation",
      event: "session.post",
      receivedAt: "2026-07-16T00:00:00.000Z",
      sessionId: "ses-1",
      outcome: "error",
      guardFailure: {
        code: "write_scope_violation",
        sessionId: "ses-1",
        path: "unknown"
      }
    });

    expect(completed).not.toHaveProperty("failureCauses");
    expect(failed.failureCauses).toEqual([{
      code: "write_scope_violation",
      stage: "scope_check",
      suggestion: "Blocked path: unknown"
    }]);
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
    expect(paths.configFile).toBe(path.join(paths.configDir, "mimocode.jsonc"));
    expect(fs.existsSync(paths.hookFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(paths.configFile, "utf-8"))).toEqual({
      dream: { auto: false },
      distill: { auto: false },
      mcp: {
        "codex-mimocode": { enabled: false }
      },
      agent: {
        "codex-mimo-readonly": {
          mode: "primary",
          description: "Codex-MiMo read-only execution policy.",
          tool_allowlist: [
            "read",
            "glob",
            "grep",
            "list",
            "lsp",
            "webfetch",
            "websearch",
            "codesearch",
            "skill",
            "view_image"
          ],
          permission: {
            "*": "deny",
            read: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            lsp: "allow",
            webfetch: "allow",
            websearch: "allow",
            codesearch: "allow",
            skill: { "compose:*": "allow" },
            view_image: "allow"
          }
        }
      }
    });
    expect(fs.readFileSync(paths.configFile, "utf-8")).not.toMatch(/model|provider/i);

    const source = fs.readFileSync(paths.hookFile, "utf-8");
    expect(source).toContain("export default async function codexMimoCallbackPlugin()");
    expect(source).toContain("return {");
    expect(source).toContain("\"session.post\"");
    expect(source).toContain(CALLBACK_HEADER);
    expect(source).not.toMatch(/finalText|trajectory|input\.error/);
    expect(source).not.toContain("export default {");
  });

  it("emits isolation hooks for query hash, primary session, and write scope", () => {
    const cwd = tempWorkspace();
    const paths = writeHookConfig({
      cwd,
      invocationId: "implement-isolation",
      endpoint: "http://127.0.0.1:12345/mimo-hook",
      token: "secret-token"
    });
    const source = fs.readFileSync(paths.hookFile, "utf-8");
    expect(source).toContain("session.pre");
    expect(source).toContain("session.userQuery.pre");
    expect(source).toContain("tool.execute.before");
    expect(source).toContain("CODEX_MIMO_EXPECTED_QUERY_HASH");
    expect(source).toContain("queryMatchesExpectedHash(input.query, expectedHash)");
    expect(source).toContain("JSON.parse(trimmedQuery)");
    expect(source).toContain("CODEX_MIMO_ALLOWED_PATHS_JSON");
  });

  it("writes an external-directory grant only for an explicit worktree run", () => {
    const cwd = tempWorkspace();
    const normal = writeHookConfig({
      cwd,
      invocationId: "implement-normal",
      endpoint: "http://127.0.0.1:12345/mimo-hook",
      token: "secret-token"
    });
    const worktree = writeHookConfig({
      cwd,
      invocationId: "compose-worktree",
      endpoint: "http://127.0.0.1:12345/mimo-hook",
      token: "secret-token",
      allowExternalDirectory: true
    });

    expect(JSON.parse(fs.readFileSync(normal.configFile, "utf-8"))).not.toHaveProperty(
      "permission"
    );
    expect(JSON.parse(fs.readFileSync(worktree.configFile, "utf-8"))).toMatchObject({
      permission: { external_directory: "allow" }
    });
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
        outcome: "completed"
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
        outcome: "completed"
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
        sessionId: "ses_valid"
      });
    } finally {
      await controller.close();
    }
  });

  it("persists only the accepted callback allowlist", async () => {
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
          error: "private-error-token",
          finalText: "transient-private-token",
          unknownRoot: "private-root-token",
          metadata: {
            trajectoryLength: 7,
            secret: "private-metadata-token"
          }
        })
      });

      await controller.waitForCallback();
      expect(fs.existsSync(controller.callbackFile)).toBe(true);
      const persisted = fs.readFileSync(controller.callbackFile, "utf-8");
      expect(JSON.parse(persisted)).toEqual({
        invocationId: controller.invocationId,
        event: "session.post",
        receivedAt: "2026-06-27T01:00:00.000Z",
        sessionId: "ses_persist",
        outcome: "cancelled"
      });
      expect(persisted).not.toMatch(/private-(?:error|root|metadata)-token|transient-private-token/);
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

  it("ignores child-session callbacks until the bound primary session posts", async () => {
    const cwd = tempWorkspace();
    const controller = await createHookCallbackController({
      cwd,
      kind: "implement",
      callbackWaitMs: 500,
      now: () => 1768040303616,
      random: () => "bind01"
    });

    expect(typeof controller.bindRunSession).toBe("function");
    controller.bindRunSession("ses-primary");

    const childResponse = await fetch(controller.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CALLBACK_HEADER]: controller.token
      },
      body: JSON.stringify({
        invocationId: controller.invocationId,
        event: "session.post",
        timestamp: "2026-07-27T00:00:00.000Z",
        sessionID: "ses-child",
        outcome: "completed"
      })
    });
    expect(childResponse.status).toBe(200);

    const waitPromise = controller.waitForCallback();
    const raced = await Promise.race([
      waitPromise.then((value) => ({ kind: "resolved" as const, value })),
      new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), 50))
    ]);
    expect(raced.kind).toBe("pending");

    const primaryResponse = await fetch(controller.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CALLBACK_HEADER]: controller.token
      },
      body: JSON.stringify({
        invocationId: controller.invocationId,
        event: "session.post",
        timestamp: "2026-07-27T00:00:01.000Z",
        sessionID: "ses-primary",
        outcome: "completed"
      })
    });
    expect(primaryResponse.status).toBe(200);
    const summary = await waitPromise;
    expect(summary?.sessionId).toBe("ses-primary");
    await controller.close();
  });
});
