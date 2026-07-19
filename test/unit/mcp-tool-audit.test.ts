import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    onmessage?: (message: unknown) => void;
    onerror?: (error: Error) => void;
    onclose?: () => void;
    async start() {}
    async send() {}
    async close() {}
  }
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type McpToolHandlers } from "../../src/codex/mcp-server.js";

const closeCallbacks: Array<() => Promise<void>> = [];
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-tool-audit-"));
});

afterEach(async () => {
  for (const close of closeCallbacks.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe.sequential("MCP tool audit", () => {
  it("does not write an audit file when the opt-in path is absent or blank", async () => {
    delete process.env.CODEX_MIMO_TOOL_AUDIT_FILE;
    const { client } = await connect({
      mimoHealthcheck: vi.fn(async () => ({ ok: true }))
    });

    const absentResult = await client.callTool({ name: "mimo_healthcheck", arguments: {} });
    expect(absentResult.isError).not.toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);

    vi.stubEnv("CODEX_MIMO_TOOL_AUDIT_FILE", "   ");
    const blankResult = await client.callTool({ name: "mimo_healthcheck", arguments: {} });

    expect(blankResult.isError).not.toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("writes only allowed keys and never persists sensitive tool input", async () => {
    const auditFile = path.join(root, "tools.jsonl");
    vi.stubEnv("CODEX_MIMO_TOOL_AUDIT_FILE", auditFile);
    const { client } = await connect({
      mimoImplement: vi.fn(async () => ({ jobId: "receipt-id", status: "queued" }))
    });

    const result = await client.callTool({
      name: "mimo_implement",
      arguments: {
        cwd: "E:/secret-workspace",
        task: "private task payload",
        allowWrite: true,
        notify: {
          type: "webhook",
          url: "https://secret.example/hook",
          secretEnv: "TOP_SECRET_TOKEN"
        }
      }
    });

    expect(result.isError).not.toBe(true);
    expect(fs.existsSync(auditFile)).toBe(true);
    const [record] = readAudit(auditFile);
    expect(Object.keys(record).sort()).toEqual(["pid", "timestamp", "toolName"]);
    expect(record).toMatchObject({ pid: process.pid, toolName: "mimo_implement" });
    expect(typeof record.timestamp).toBe("string");
    const raw = fs.readFileSync(auditFile, "utf8");
    for (const sensitive of [
      "E:/secret-workspace",
      "private task payload",
      "receipt-id",
      "https://secret.example/hook",
      "TOP_SECRET_TOKEN"
    ]) {
      expect(raw).not.toContain(sensitive);
    }
  });

  it("never persists secret-shaped job IDs from status, result, cancel, or resume", async () => {
    const auditFile = path.join(root, "tools.jsonl");
    const secretJobId = "job-ghp_audit_secret_123";
    vi.stubEnv("CODEX_MIMO_TOOL_AUDIT_FILE", auditFile);
    const { client } = await connect({
      mimoStatus: vi.fn(async () => ({ status: "completed" })),
      mimoResult: vi.fn(async () => ({ status: "completed" })),
      mimoCancel: vi.fn(async () => ({ status: "cancelled" })),
      mimoResume: vi.fn(async () => ({ jobId: "child-1", status: "queued" }))
    });

    for (const call of [
      { name: "mimo_status", arguments: { cwd: "E:/project", jobId: secretJobId } },
      { name: "mimo_result", arguments: { cwd: "E:/project", jobId: secretJobId } },
      { name: "mimo_cancel", arguments: { cwd: "E:/project", jobId: secretJobId } },
      { name: "mimo_resume", arguments: { cwd: "E:/project", jobId: secretJobId, task: "continue" } }
    ]) {
      const result = await client.callTool(call);
      expect(result.isError).not.toBe(true);
    }

    expect(fs.existsSync(auditFile)).toBe(true);
    expect(readAudit(auditFile).map((record) => record.toolName)).toEqual([
      "mimo_status",
      "mimo_result",
      "mimo_cancel",
      "mimo_resume"
    ]);
    for (const record of readAudit(auditFile)) {
      expect(Object.keys(record).sort()).toEqual(["pid", "timestamp", "toolName"]);
    }
    expect(fs.readFileSync(auditFile, "utf8")).not.toContain(secretJobId);
  });

  it("does not audit invalid input rejected before the registered handler", async () => {
    const auditFile = path.join(root, "tools.jsonl");
    vi.stubEnv("CODEX_MIMO_TOOL_AUDIT_FILE", auditFile);
    const resultHandler = vi.fn(async () => ({ status: "completed" }));
    const { client } = await connect({ mimoResult: resultHandler });

    const result = await client.callTool({
      name: "mimo_result",
      arguments: { cwd: "E:/project", jobId: 123, task: "must not leak" }
    });

    expect(result.isError).toBe(true);
    expect(resultHandler).not.toHaveBeenCalled();
    expect(fs.existsSync(auditFile)).toBe(false);
  });

  it("appends one JSONL record for each validated tool call", async () => {
    const auditFile = path.join(root, "tools.jsonl");
    vi.stubEnv("CODEX_MIMO_TOOL_AUDIT_FILE", auditFile);
    const { client } = await connect({
      mimoHealthcheck: vi.fn(async () => ({ ok: true }))
    });

    await client.callTool({ name: "mimo_healthcheck", arguments: {} });
    await client.callTool({ name: "mimo_healthcheck", arguments: { cwd: "E:/project" } });

    expect(fs.existsSync(auditFile)).toBe(true);
    expect(readAudit(auditFile).map((record) => record.toolName)).toEqual([
      "mimo_healthcheck",
      "mimo_healthcheck"
    ]);
    expect(fs.readFileSync(auditFile, "utf8").endsWith("\n")).toBe(true);
  });

  it("treats audit write failure as best-effort and still runs the tool handler", async () => {
    vi.stubEnv("CODEX_MIMO_TOOL_AUDIT_FILE", root);
    const handler = vi.fn(async () => ({ ok: true }));
    const { client } = await connect({ mimoHealthcheck: handler });

    const result = await client.callTool({ name: "mimo_healthcheck", arguments: {} });

    expect(result.isError).not.toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });
});

async function connect(overrides: Partial<McpToolHandlers>): Promise<{ client: Client }> {
  const server = createMcpServer(overrides);
  const client = new Client({ name: "tool-audit-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(() => server.close(), () => client.close());
  return { client };
}

function readAudit(file: string): Array<Record<string, unknown>> {
  return fs.readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
