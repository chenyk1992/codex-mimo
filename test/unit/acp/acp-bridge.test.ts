import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockStdout: PassThrough;
let capturedStdin: string[];
let agentRequestDefs: Array<{ method: string; id: number; params: unknown }>;
let promptResultOverride: unknown;
let decideFileWriteOverride: string | null = null;

vi.mock("../../../src/mimo/acp-process.js", () => ({
  startMimoAcp: vi.fn(() => ({
    process: {
      get stdin() { return { write: (data: string) => handleBridgeWrite(data) }; },
      stdout: mockStdout,
      stderr: new PassThrough(),
      kill: vi.fn(),
      send: vi.fn()
    },
    write: (data: string) => handleBridgeWrite(data),
    stop: vi.fn()
  }))
}));

vi.mock("../../../src/core/policy.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../src/core/policy.js")>();
  return {
    ...mod,
    decideFileWrite: (...args: Parameters<typeof mod.decideFileWrite>) =>
      decideFileWriteOverride !== null ? decideFileWriteOverride as never : mod.decideFileWrite(...args)
  };
});

const INIT_RESULT = { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "mimo", version: "1.0.0" } };
const SESSION_RESULT = { sessionId: "sess_abc123" };

function handleBridgeWrite(data: string): void {
  capturedStdin.push(data);
  for (const line of data.split("\n").filter(Boolean)) {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      mockStdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: INIT_RESULT }) + "\n");
    } else if (msg.method === "session/new") {
      mockStdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: SESSION_RESULT }) + "\n");
    } else if (msg.method === "session/prompt") {
      for (const req of agentRequestDefs) {
        mockStdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, method: req.method, params: req.params }) + "\n");
      }
      mockStdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: promptResultOverride ?? { stopReason: "end_turn" } }) + "\n");
    }
  }
}

import { AcpBridge } from "../../../src/mimo/acp-bridge.js";
import { defaultPolicy } from "../../../src/core/policy.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-acp-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function stdinMessages(): Array<Record<string, unknown>> {
  return capturedStdin
    .flatMap((chunk) => chunk.split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForStdinResponse(id: number): Promise<Record<string, unknown>> {
  let resp: Record<string, unknown> | undefined;
  await vi.waitFor(() => {
    resp = stdinMessages().find((m) => m.id === id);
    expect(resp).toBeDefined();
  }, { timeout: 2000 });
  return resp!;
}

describe("ACP Bridge", () => {
  beforeEach(() => {
    mockStdout = new PassThrough();
    capturedStdin = [];
    agentRequestDefs = [];
    promptResultOverride = undefined;
    decideFileWriteOverride = null;
  });

  describe("protocol lifecycle (7.1-7.4)", () => {
    it("7.1: full lifecycle returns events, sessionId, stopReason", async () => {
      const cwd = tempDir();
      const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
      const result = await bridge.run("hello");
      expect(result.sessionId).toBe("sess_abc123");
      expect(result.stopReason).toBe("end_turn");
      expect(Array.isArray(result.events)).toBe(true);
    });

    it("7.3: session/new stores sessionId", async () => {
      const cwd = tempDir();
      const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
      const result = await bridge.run("test");
      expect(result.sessionId).toBe("sess_abc123");
    });

    it("7.4: session/prompt returns stopReason", async () => {
      promptResultOverride = { stopReason: "max_tokens" };
      const cwd = tempDir();
      const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
      const result = await bridge.run("test");
      expect(result.stopReason).toBe("max_tokens");
    });
  });

  describe("agent request handlers (7.5-7.12)", () => {
    it("7.5: fs/read_text_file inside workspace returns content", async () => {
      const cwd = tempDir();
      fs.writeFileSync(path.join(cwd, "hello.txt"), "hello world");
      agentRequestDefs = [{
        method: "fs/read_text_file", id: 100,
        params: { sessionId: "sess_abc123", path: path.join(cwd, "hello.txt").replace(/\\/g, "/") }
      }];
      const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
      await bridge.run("read file");
      const resp = await waitForStdinResponse(100) as { result?: { content?: string } };
      expect(resp.result!.content).toBe("hello world");
    });

    it("7.6: fs/read_text_file outside workspace returns policy error", async () => {
      const cwd = tempDir();
      const outsidePath = path.join(os.tmpdir(), "outside-acp-bridge.txt").replace(/\\/g, "/");
      fs.writeFileSync(outsidePath, "secret");
      try {
        agentRequestDefs = [{
          method: "fs/read_text_file", id: 100,
          params: { sessionId: "sess_abc123", path: outsidePath }
        }];
        const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
        await bridge.run("read outside");
        const resp = await waitForStdinResponse(100) as { result?: { error?: string } };
        expect(resp.result!.error).toContain("Read denied by policy");
      } finally {
        try { fs.unlinkSync(outsidePath); } catch { /* ignore */ }
      }
    });

    it("7.7: fs/read_text_file missing file returns read error", async () => {
      const cwd = tempDir();
      agentRequestDefs = [{
        method: "fs/read_text_file", id: 100,
        params: { sessionId: "sess_abc123", path: path.join(cwd, "nope.txt").replace(/\\/g, "/") }
      }];
      const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
      await bridge.run("read missing");
      const resp = await waitForStdinResponse(100) as { result?: { error?: string } };
      expect(resp.result!.error).toContain("Failed to read file");
    });

    it("7.8: fs/write_text_file allowed writes file", async () => {
      const cwd = tempDir();
      const targetPath = path.join(cwd, "output.txt").replace(/\\/g, "/");
      decideFileWriteOverride = "allow";
      agentRequestDefs = [{
        method: "fs/write_text_file", id: 100,
        params: { sessionId: "sess_abc123", path: targetPath, content: "written content" }
      }];
      const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
      await bridge.run("write file");
      expect(fs.readFileSync(path.join(cwd, "output.txt"), "utf-8")).toBe("written content");
    });

    it("7.9: fs/write_text_file denied returns error", async () => {
      const cwd = tempDir();
      const targetPath = path.join(cwd, "output.txt").replace(/\\/g, "/");
      agentRequestDefs = [{
        method: "fs/write_text_file", id: 100,
        params: { sessionId: "sess_abc123", path: targetPath, content: "nope" }
      }];
      const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
      await bridge.run("write denied");
      const resp = await waitForStdinResponse(100) as { result?: { error?: string } };
      expect(resp.result!.error).toContain("Write denied by policy");
    });

    it("7.10: terminal/create allowed returns terminalId", async () => {
      const cwd = tempDir();
      const { TerminalManager } = await import("../../../src/core/terminal.js");
      vi.spyOn(TerminalManager.prototype, "create").mockReturnValue({
        id: "term_1", process: {} as never, stdout: "", stderr: "", exitCode: 0
      });
      try {
        agentRequestDefs = [{
          method: "terminal/create", id: 100,
          params: { sessionId: "sess_abc123", command: "git", args: ["status"] }
        }];
        const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
        await bridge.run("create terminal");
        const resp = await waitForStdinResponse(100) as { result?: { terminalId?: string } };
        expect(resp.result!.terminalId).toBeTruthy();
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("7.11: terminal/create denied returns error", async () => {
      const cwd = tempDir();
      agentRequestDefs = [{
        method: "terminal/create", id: 100,
        params: { sessionId: "sess_abc123", command: "git", args: ["push", "origin", "main"] }
      }];
      const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
      await bridge.run("denied terminal");
      const resp = await waitForStdinResponse(100) as { result?: { error?: string } };
      expect(resp.result!.error).toContain("Command denied by policy");
    });

    it("7.12: session/request_permission allow path selects option", async () => {
      const cwd = tempDir();
      agentRequestDefs = [{
        method: "session/request_permission", id: 100,
        params: {
          sessionId: "sess_abc123",
          toolCall: {
            toolCallId: "tc_1", title: "npm test", kind: "terminal",
            input: { command: "npm", args: ["test"] }
          },
          options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }]
        }
      }];
      const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
      await bridge.run("permission allow");
      const resp = await waitForStdinResponse(100) as { result?: { outcome?: { outcome?: string; optionId?: string } } };
      expect(resp.result!.outcome!.outcome).toBe("selected");
      expect(resp.result!.outcome!.optionId).toBe("allow");
    });

    it("7.12b: session/request_permission deny path returns cancelled", async () => {
      const cwd = tempDir();
      agentRequestDefs = [{
        method: "session/request_permission", id: 100,
        params: {
          sessionId: "sess_abc123",
          toolCall: {
            toolCallId: "tc_2", title: "git push", kind: "terminal",
            input: { command: "git", args: ["push", "origin", "main"] }
          },
          options: [{ id: "allow", label: "Allow" }]
        }
      }];
      const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
      await bridge.run("permission deny");
      const resp = await waitForStdinResponse(100) as { result?: { outcome?: { outcome?: string } } };
      expect(resp.result!.outcome!.outcome).toBe("cancelled");
    });
  });

  describe("terminal management (7.13-7.17)", () => {
    it("7.13: terminal/output returns stdout+stderr", async () => {
      const cwd = tempDir();
      const { TerminalManager } = await import("../../../src/core/terminal.js");
      vi.spyOn(TerminalManager.prototype, "get").mockReturnValue({
        id: "term_1", process: {} as never, stdout: "line1\n", stderr: "err1\n", exitCode: 0
      });
      try {
        agentRequestDefs = [{
          method: "terminal/output", id: 100,
          params: { sessionId: "sess_abc123", terminalId: "term_1" }
        }];
        const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
        await bridge.run("check output");
        const resp = await waitForStdinResponse(100) as { result?: { output?: string; exitStatus?: number } };
        expect(resp.result!.output).toBe("line1\nerr1\n");
        expect(resp.result!.exitStatus).toBe(0);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("7.14: terminal/output unknown id returns exitStatus -1", async () => {
      const cwd = tempDir();
      const { TerminalManager } = await import("../../../src/core/terminal.js");
      vi.spyOn(TerminalManager.prototype, "get").mockReturnValue(undefined);
      try {
        agentRequestDefs = [{
          method: "terminal/output", id: 100,
          params: { sessionId: "sess_abc123", terminalId: "nonexistent" }
        }];
        const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
        await bridge.run("unknown terminal");
        const resp = await waitForStdinResponse(100) as { result?: { exitStatus?: number } };
        expect(resp.result!.exitStatus).toBe(-1);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("7.15: terminal/wait_for_exit returns exitStatus", async () => {
      const cwd = tempDir();
      const { TerminalManager } = await import("../../../src/core/terminal.js");
      vi.spyOn(TerminalManager.prototype, "waitForExit").mockResolvedValue({
        id: "term_1", process: {} as never, stdout: "done\n", stderr: "", exitCode: 0
      });
      try {
        agentRequestDefs = [{
          method: "terminal/wait_for_exit", id: 100,
          params: { sessionId: "sess_abc123", terminalId: "term_1" }
        }];
        const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
        await bridge.run("wait exit");
        const resp = await waitForStdinResponse(100) as { result?: { exitStatus?: number } };
        expect(resp.result!.exitStatus).toBe(0);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("7.16: terminal/wait_for_exit timeout rejects", async () => {
      const cwd = tempDir();
      const { TerminalManager } = await import("../../../src/core/terminal.js");
      vi.spyOn(TerminalManager.prototype, "waitForExit").mockRejectedValue(
        new Error("Terminal term_1 timed out after 1ms")
      );
      try {
        agentRequestDefs = [{
          method: "terminal/wait_for_exit", id: 100,
          params: { sessionId: "sess_abc123", terminalId: "term_1", timeoutMs: 1 }
        }];
        const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
        await bridge.run("wait timeout");
        const resp = await waitForStdinResponse(100) as { error?: { message?: string } };
        expect(resp.error!.message).toContain("timed out");
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("7.17: terminal/kill and terminal/release call manager methods", async () => {
      const cwd = tempDir();
      const { TerminalManager } = await import("../../../src/core/terminal.js");
      const mockKill = vi.spyOn(TerminalManager.prototype, "kill").mockImplementation(() => {});
      const mockRelease = vi.spyOn(TerminalManager.prototype, "release").mockImplementation(() => {});
      try {
        agentRequestDefs = [
          { method: "terminal/kill", id: 100, params: { sessionId: "sess_abc123", terminalId: "term_1" } },
          { method: "terminal/release", id: 101, params: { sessionId: "sess_abc123", terminalId: "term_1" } }
        ];
        const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
        await bridge.run("kill release");
        expect(mockKill).toHaveBeenCalledWith("term_1");
        expect(mockRelease).toHaveBeenCalledWith("term_1");
      } finally {
        mockKill.mockRestore();
        mockRelease.mockRestore();
      }
    });
  });
});
