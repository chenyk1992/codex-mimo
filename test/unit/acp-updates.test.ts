import { describe, expect, it } from "vitest";
import { convertUpdate } from "../../src/mimo/acp-updates.js";

describe("convertUpdate", () => {
  it("converts agent_message_chunk updates", () => {
    const event = convertUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", messageId: "msg_1", content: { type: "text", text: "hello" } }
    });
    expect(event).toEqual({ type: "message", role: "agent", text: "hello", messageId: "msg_1" });
  });

  it("converts plan updates", () => {
    const event = convertUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Step 1", status: "pending" }]
      }
    });
    expect(event.type).toBe("plan");
    if (event.type === "plan") {
      expect(event.entries).toHaveLength(1);
    }
  });

  it("converts tool_call updates", () => {
    const event = convertUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "tool_call", toolCallId: "call_1", title: "Read file", kind: "fs", status: "running" }
    });
    expect(event).toEqual({
      type: "tool",
      id: "call_1",
      title: "Read file",
      kind: "fs",
      status: "running"
    });
  });

  it("converts tool_call_update updates", () => {
    const event = convertUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" }
    });
    expect(event).toEqual({
      type: "tool",
      id: "call_1",
      title: "",
      kind: "",
      status: "completed"
    });
  });

  it("converts usage_update updates", () => {
    const event = convertUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "usage_update", used: 100, size: 1000 }
    });
    expect(event).toEqual({
      type: "usage",
      used: 100,
      size: 1000,
      cost: undefined
    });
  });
});
