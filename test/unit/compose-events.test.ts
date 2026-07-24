import { describe, expect, it } from "vitest";
import { extractSessionIdFromRawLine, normalizeMimoEvent, parseMimoJsonLines } from "../../src/compose/events.js";

describe("compose event parsing", () => {
  it("normalizes public message events", () => {
    expect(normalizeMimoEvent({ type: "message", text: "hello" })).toMatchObject({
      type: "message",
      text: "hello"
    });
  });

  it("parses newline-delimited JSON events", () => {
    const events = parseMimoJsonLines('{"type":"message","text":"hello"}\n{"type":"tool","tool":"bash","status":"completed"}\n');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "message", text: "hello" });
    expect(events[1]).toMatchObject({ type: "tool", toolName: "bash", status: "completed" });
  });

  it("keeps unknown shapes as raw events", () => {
    const events = parseMimoJsonLines('{"unexpected":true}\n');
    expect(events).toEqual([{ type: "raw", raw: { unexpected: true } }]);
  });

  it.each([
    [{ type: "error", message: "model failed" }, "model failed"],
    [{ type: "error", part: { message: "tool failed" } }, "tool failed"],
    [{ type: "error", part: { text: "command failed" } }, "command failed"]
  ])("extracts canonical text from MiMo type:error JSONL %#", (raw, text) => {
    expect(normalizeMimoEvent(raw)).toMatchObject({ type: "error", text });
  });

  it("extracts text from MiMo raw message parts", () => {
    const events = parseMimoJsonLines(
      '{"type":"message","raw":{"type":"text","part":{"type":"text","text":"What would you like to accomplish?"}}}\n'
    );

    expect(events[0]).toMatchObject({
      type: "message",
      text: "What would you like to accomplish?"
    });
  });

  it("extracts text from top-level MiMo text parts", () => {
    const events = parseMimoJsonLines(
      '{"type":"text","part":{"type":"text","text":"What would you like me to help with?"}}\n'
    );

    expect(events[0]).toMatchObject({
      type: "message",
      text: "What would you like me to help with?"
    });
  });

  it("normalizes MiMo tool_use raw events as tool progress", () => {
    const event = normalizeMimoEvent({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          input: { file_path: "src/compose/events.ts" }
        }
      }
    });

    expect(event).toMatchObject({
      type: "tool",
      toolName: "read",
      status: "completed",
      text: "src/compose/events.ts"
    });
  });

  it.each(["read", "write", "edit"])("prefers canonical file_path for %s events", (tool) => {
    const event = normalizeMimoEvent({
      type: "tool_use",
      part: {
        type: "tool",
        tool,
        state: {
          input: {
            file_path: "src/canonical.ts",
            filePath: "src/fallback.ts",
            path: "src/last.ts"
          }
        }
      }
    });

    expect(event).toMatchObject({ type: "tool", toolName: tool, text: "src/canonical.ts" });
  });

  it("extracts MiMo sessionID (uppercase) from a raw JSONL line", () => {
    const line = JSON.stringify({
      type: "step_start",
      sessionID: "ses_upper",
      part: { type: "step-start", sessionID: "ses_part" }
    });

    expect(extractSessionIdFromRawLine(line)).toBe("ses_upper");
  });

  it("extracts MiMo sessionId from nested part in a raw JSONL line", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "read",
        sessionId: "ses_nested",
        state: { status: "completed", input: { file_path: "README.md" } }
      }
    });

    expect(extractSessionIdFromRawLine(line)).toBe("ses_nested");
  });

  it("returns null for lines without a session id", () => {
    expect(extractSessionIdFromRawLine('{"type":"message","text":"hello"}')).toBeNull();
  });

  it("returns null for blank or malformed lines", () => {
    expect(extractSessionIdFromRawLine("   ")).toBeNull();
    expect(extractSessionIdFromRawLine("not json")).toBeNull();
  });
});
