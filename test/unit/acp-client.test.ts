import { describe, expect, it, vi } from "vitest";
import { AcpClient, encodeMessage, JsonRpcLineParser } from "../../src/mimo/acp-client.js";
import type { JsonRpcMessage, SessionUpdateParams } from "../../src/mimo/acp-types.js";

describe("JsonRpcLineParser", () => {
  it("parses newline-delimited JSON-RPC messages", () => {
    const parser = new JsonRpcLineParser();
    const messages = parser.push(
      '{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","method":"session/update","params":{}}\n'
    );
    expect(messages).toHaveLength(2);
  });

  it("buffers partial messages", () => {
    const parser = new JsonRpcLineParser();
    expect(parser.push('{"jsonrpc":"2.0"')).toEqual([]);
    expect(parser.push(',"id":1,"result":{}}\n')).toHaveLength(1);
  });

  it("encodes messages with newline delimiter", () => {
    expect(encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize" })).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'
    );
  });
});

describe("AcpClient", () => {
  function createTestClient() {
    const written: string[] = [];
    const updates: SessionUpdateParams[] = [];
    const agentRequests: Array<{ method: string; params: unknown }> = [];

    const client = new AcpClient(
      (data) => written.push(data),
      async (method, params) => {
        agentRequests.push({ method, params });
        return { outcome: "allow" };
      },
      (params) => updates.push(params)
    );

    return { client, written, updates, agentRequests };
  }

  it("sends initialize request", async () => {
    const { client, written } = createTestClient();
    const promise = client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "test", title: "Test", version: "0.1.0" }
    });

    expect(written).toHaveLength(1);
    const sent = JSON.parse(written[0]) as JsonRpcMessage;
    expect(sent).toHaveProperty("method", "initialize");

    client.onData(JSON.stringify({ jsonrpc: "2.0", id: (sent as { id: number }).id, result: { protocolVersion: 1 } }) + "\n");
    const result = await promise;
    expect(result).toEqual({ protocolVersion: 1 });
  });

  it("handles session/new", async () => {
    const { client, written } = createTestClient();
    const promise = client.sessionNew({ cwd: "/test" });

    const sent = JSON.parse(written[0]) as { id: number };
    client.onData(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { sessionId: "sess_123" } }) + "\n");

    const result = await promise;
    expect(result).toEqual({ sessionId: "sess_123" });
  });

  it("dispatches session/update notifications to handler", () => {
    const { client, updates } = createTestClient();
    client.onData(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { type: "message", role: "agent", text: "hello" } }
      }) + "\n"
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].update.type).toBe("message");
  });

  it("handles agent-to-client requests and sends response", async () => {
    const { client, written, agentRequests } = createTestClient();
    client.onData(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 100,
        method: "fs/read_text_file",
        params: { sessionId: "s1", path: "/test/file.ts" }
      }) + "\n"
    );

    await vi.waitFor(() => {
      expect(written.length).toBeGreaterThanOrEqual(1);
    });

    expect(agentRequests).toHaveLength(1);
    expect(agentRequests[0].method).toBe("fs/read_text_file");

    const response = JSON.parse(written[0]) as { id: number; result: unknown };
    expect(response.id).toBe(100);
    expect(response.result).toEqual({ outcome: "allow" });
  });

  it("rejects pending requests on error response", async () => {
    const { client, written } = createTestClient();
    const promise = client.sessionNew({ cwd: "/test" });

    const sent = JSON.parse(written[0]) as { id: number };
    client.onData(
      JSON.stringify({
        jsonrpc: "2.0",
        id: sent.id,
        error: { code: -32600, message: "Invalid request" }
      }) + "\n"
    );

    await expect(promise).rejects.toThrow("ACP error -32600: Invalid request");
  });
});
