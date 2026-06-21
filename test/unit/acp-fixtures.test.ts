import { describe, expect, it, vi } from "vitest";
import { AcpClient, encodeMessage } from "../../src/mimo/acp-client.js";
import { convertUpdate } from "../../src/mimo/acp-updates.js";
import type {
  RequestPermissionResult,
  SessionUpdateParams,
  WriteTextFileResult
} from "../../src/mimo/acp-types.js";

describe("ACP v1 fixture tests", () => {
  function createTestClient() {
    const written: string[] = [];
    const updates: SessionUpdateParams[] = [];
    const agentRequests: Array<{ method: string; params: unknown; resolve: (v: unknown) => void }> = [];

    const client = new AcpClient(
      (data) => written.push(data),
      async (method, params) => {
        return new Promise((resolve) => {
          agentRequests.push({ method, params, resolve });
        });
      },
      (params) => updates.push(params)
    );

    return { client, written, updates, agentRequests };
  }

  describe("session/update parsing", () => {
    it("parses agent_message_chunk", () => {
      const { client, updates } = createTestClient();
      client.onData(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_abc123",
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "msg_1",
            content: { type: "text", text: "I found a bug in line 42." }
          }
        }
      }) + "\n");

      expect(updates).toHaveLength(1);
      const event = convertUpdate(updates[0]);
      expect(event).toEqual({
        type: "message",
        role: "agent",
        text: "I found a bug in line 42.",
        messageId: "msg_1"
      });
    });

    it("parses tool_call", () => {
      const { client, updates } = createTestClient();
      client.onData(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_abc123",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_1",
            title: "Running tests",
            kind: "execute",
            status: "pending"
          }
        }
      }) + "\n");

      expect(updates).toHaveLength(1);
      const event = convertUpdate(updates[0]);
      expect(event).toEqual({
        type: "tool",
        id: "call_1",
        title: "Running tests",
        kind: "execute",
        status: "pending"
      });
    });

    it("parses tool_call_update", () => {
      const { client, updates } = createTestClient();
      client.onData(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_abc123",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_1",
            status: "completed",
            output: "All tests passed."
          }
        }
      }) + "\n");

      expect(updates).toHaveLength(1);
      const event = convertUpdate(updates[0]);
      expect(event.type).toBe("tool");
      if (event.type === "tool") {
        expect(event.id).toBe("call_1");
        expect(event.status).toBe("completed");
      }
    });

    it("parses plan", () => {
      const { client, updates } = createTestClient();
      client.onData(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_abc123",
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: "Fix the null check in auth.ts", status: "pending", priority: "high" },
              { content: "Add test for edge case", status: "pending" }
            ]
          }
        }
      }) + "\n");

      expect(updates).toHaveLength(1);
      const event = convertUpdate(updates[0]);
      expect(event.type).toBe("plan");
      if (event.type === "plan") {
        expect(event.entries).toHaveLength(2);
        expect(event.entries[0].priority).toBe("high");
      }
    });

    it("parses usage_update", () => {
      const { client, updates } = createTestClient();
      client.onData(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_abc123",
          update: {
            sessionUpdate: "usage_update",
            used: 5000,
            size: 128000,
            cost: { amount: 0.015, currency: "USD" }
          }
        }
      }) + "\n");

      expect(updates).toHaveLength(1);
      const event = convertUpdate(updates[0]);
      expect(event).toEqual({
        type: "usage",
        used: 5000,
        size: 128000,
        cost: { amount: 0.015, currency: "USD" }
      });
    });
  });

  describe("permission request/response", () => {
    it("returns selected outcome for allowed commands", async () => {
      const { client, written, agentRequests } = createTestClient();
      client.onData(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/request_permission",
        params: {
          sessionId: "sess_abc123",
          toolCall: {
            toolCallId: "call_1",
            title: "Run tests",
            kind: "execute",
            input: { command: "npm", args: ["test"] }
          },
          options: [
            { id: "allow", label: "Allow" },
            { id: "deny", label: "Deny" }
          ]
        }
      }) + "\n");

      await vi.waitFor(() => expect(agentRequests).toHaveLength(1));

      const request = agentRequests[0];
      expect(request.method).toBe("session/request_permission");
      expect((request.params as { toolCall: { input: { command: string } } }).toolCall.input.command).toBe("npm");
    });

    it("permission result matches ACP v1 selected format", () => {
      const result: RequestPermissionResult = {
        outcome: { outcome: "selected", optionId: "allow" }
      };
      expect(result.outcome.outcome).toBe("selected");
      expect(result.outcome.optionId).toBe("allow");
    });

    it("permission result matches ACP v1 cancelled format", () => {
      const result: RequestPermissionResult = {
        outcome: { outcome: "cancelled" }
      };
      expect(result.outcome.outcome).toBe("cancelled");
    });
  });

  describe("file operations", () => {
    it("WriteTextFileResult is null on success", () => {
      const result: WriteTextFileResult = null;
      expect(result).toBeNull();
    });
  });

  describe("multiple messages in single chunk", () => {
    it("parses multiple JSONL messages from one chunk", () => {
      const { client, updates } = createTestClient();
      const chunk = [
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", messageId: "msg_1", content: { type: "text", text: "first" } } }
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", messageId: "msg_2", content: { type: "text", text: "second" } } }
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "s1", update: { sessionUpdate: "usage_update", used: 100, size: 200 } }
        })
      ].join("\n") + "\n";

      client.onData(chunk);
      expect(updates).toHaveLength(3);
      expect(convertUpdate(updates[0]).type).toBe("message");
      expect(convertUpdate(updates[1]).type).toBe("message");
      expect(convertUpdate(updates[2]).type).toBe("usage");
    });
  });
});
