import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPolicy } from "../../../src/core/policy.js";

let mockStdout: PassThrough;
let capturedStdin: string[];
let agentRequestDefs: Array<{ method: string; id: number; params: unknown }>;

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
      mockStdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }) + "\n");
    }
  }
}

import { AcpBridge } from "../../../src/mimo/acp-bridge.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-acp-policy-"));
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

describe("ACP Bridge Policy Enforcement", () => {
  beforeEach(() => {
    mockStdout = new PassThrough();
    capturedStdin = [];
    agentRequestDefs = [];
  });

  it("7.18: CI mode converts all ask decisions to deny", async () => {
    const cwd = tempDir();
    const policy = { ...defaultPolicy(cwd), ciMode: true, nonInteractive: true };
    agentRequestDefs = [{
      method: "fs/write_text_file", id: 100,
      params: { sessionId: "sess_abc123", path: path.join(cwd, "out.txt").replace(/\\/g, "/"), content: "data" }
    }];
    const bridge = new AcpBridge({ cwd, policy });
    await bridge.run("ci write");
    const resp = await waitForStdinResponse(100) as { result?: { error?: string } };
    expect(resp.result!.error).toContain("Write denied by policy");
  });

  it("7.19: denied commands produce deny result", async () => {
    const cwd = tempDir();
    agentRequestDefs = [{
      method: "session/request_permission", id: 100,
      params: {
        sessionId: "sess_abc123",
        toolCall: {
          toolCallId: "tc_1", title: "git push", kind: "terminal",
          input: { command: "git", args: ["push", "origin", "main"] }
        },
        options: [{ id: "allow", label: "Allow" }]
      }
    }];
    const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
    await bridge.run("deny cmd");
    const resp = await waitForStdinResponse(100) as { result?: { outcome?: { outcome?: string } } };
    expect(resp.result!.outcome!.outcome).toBe("cancelled");
  });

  it("7.20: audit log records file operations", async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, "data.txt"), "content");
    agentRequestDefs = [
      { method: "fs/read_text_file", id: 100, params: { sessionId: "sess_abc123", path: path.join(cwd, "data.txt").replace(/\\/g, "/") } },
      { method: "fs/read_text_file", id: 101, params: { sessionId: "sess_abc123", path: path.join(cwd, "missing.txt").replace(/\\/g, "/") } }
    ];
    const bridge = new AcpBridge({ cwd, policy: defaultPolicy(cwd) });
    await bridge.run("audit test");
    await new Promise((r) => setTimeout(r, 200));
    const logPath = path.join(cwd, ".codex-mimo", "audit.jsonl");
    expect(fs.existsSync(logPath)).toBe(true);
    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    const entries = lines.map((l) => JSON.parse(l));
    const fileReads = entries.filter((e: { type: string }) => e.type === "file_read");
    expect(fileReads.length).toBeGreaterThanOrEqual(2);
    expect(entries.some((e: { type: string }) => e.type === "session_start")).toBe(true);
    expect(entries.some((e: { type: string }) => e.type === "session_end")).toBe(true);
  });
});
