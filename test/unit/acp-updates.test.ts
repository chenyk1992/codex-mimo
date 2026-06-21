import { describe, expect, it } from "vitest";
import { convertUpdate } from "../../src/mimo/acp-updates.js";

describe("convertUpdate", () => {
  it("converts message updates", () => {
    const event = convertUpdate({
      sessionId: "s1",
      update: { type: "message", role: "agent", text: "hello" }
    });
    expect(event).toEqual({ type: "message", role: "agent", text: "hello", messageId: undefined });
  });

  it("converts plan updates", () => {
    const event = convertUpdate({
      sessionId: "s1",
      update: {
        type: "plan",
        entries: [{ content: "Step 1", status: "pending" }]
      }
    });
    expect(event.type).toBe("plan");
    if (event.type === "plan") {
      expect(event.entries).toHaveLength(1);
    }
  });

  it("converts tool updates", () => {
    const event = convertUpdate({
      sessionId: "s1",
      update: { type: "tool", id: "t1", title: "Read file", kind: "fs", status: "running" }
    });
    expect(event).toEqual({
      type: "tool",
      id: "t1",
      title: "Read file",
      kind: "fs",
      status: "running"
    });
  });

  it("converts diff updates", () => {
    const event = convertUpdate({
      sessionId: "s1",
      update: { type: "diff", path: "src/index.ts", oldText: "old", newText: "new" }
    });
    expect(event).toEqual({
      type: "diff",
      path: "src/index.ts",
      oldText: "old",
      newText: "new"
    });
  });

  it("converts terminal updates", () => {
    const event = convertUpdate({
      sessionId: "s1",
      update: { type: "terminal", id: "term_1", output: "ok", exitCode: 0 }
    });
    expect(event).toEqual({
      type: "terminal",
      id: "term_1",
      output: "ok",
      exitCode: 0
    });
  });

  it("converts usage updates", () => {
    const event = convertUpdate({
      sessionId: "s1",
      update: { type: "usage", used: 100, size: 1000 }
    });
    expect(event).toEqual({
      type: "usage",
      used: 100,
      size: 1000,
      cost: undefined
    });
  });
});
