import { afterEach, describe, expect, it, vi } from "vitest";

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
import { createMcpServer } from "../../src/codex/mcp-server.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closeCallbacks.splice(0).reverse()) await close();
});

describe("MCP strict input validation", () => {
  it("rejects unknown fields before handlers and accepts legal inputs", async () => {
    const waitHandler = vi.fn(async () => ({ marker: "wait-handler" }));
    const planHandler = vi.fn(async () => ({ marker: "plan-handler" }));
    const server = createMcpServer({ mimoWait: waitHandler, mimoPlan: planHandler });
    const client = new Client({ name: "strict-input-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(() => server.close(), () => client.close());

    const invalidWait = await client.callTool({
      name: "mimo_wait",
      arguments: { cwd: "E:/project", timeoutMs: 10, pollMs: 1 }
    });
    expect(invalidWait.isError).toBe(true);
    expect(invalidWait.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("Input validation error") })
    ]));
    expect(waitHandler).not.toHaveBeenCalled();

    const invalidPlan = await client.callTool({
      name: "mimo_plan",
      arguments: { cwd: "E:/project", task: "Plan", background: true, agent: "legacy" }
    });
    expect(invalidPlan.isError).toBe(true);
    expect(planHandler).not.toHaveBeenCalled();

    const legalWait = await client.callTool({
      name: "mimo_wait",
      arguments: { cwd: "E:/project", timeoutMs: 10 }
    });
    expect(legalWait.isError).not.toBe(true);
    expect(waitHandler).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "E:/project", sinceCursor: 0, limit: 20, minLevel: "info", timeoutMs: 10
    }));

    const legalPlan = await client.callTool({
      name: "mimo_plan",
      arguments: { cwd: "E:/project", task: "Plan" }
    });
    expect(legalPlan.isError).not.toBe(true);
    expect(planHandler).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "E:/project", task: "Plan", timeoutMs: 1_800_000
    }));
  });
});
