import { describe, expect, it } from "vitest";
import { normalizeMimoEvent, parseMimoJsonLines, summarizeEvents } from "../../src/compose/events.js";

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

  it("summarizes message and tool counts", () => {
    const events = parseMimoJsonLines('{"type":"message","text":"hello"}\n{"type":"tool","tool":"edit","status":"completed"}\n');
    expect(summarizeEvents(events)).toMatchObject({
      messages: 1,
      tools: 1,
      diffs: 0,
      errors: 0
    });
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
          input: { filePath: "src/compose/events.ts" }
        }
      }
    });

    expect(event).toMatchObject({
      type: "tool",
      toolName: "read",
      status: "completed"
    });
  });

  it("counts raw progress events separately from unknown raw events", () => {
    const summary = summarizeEvents([
      normalizeMimoEvent({ type: "step_start", part: { type: "step-start" } }),
      normalizeMimoEvent({ type: "step_finish", part: { type: "step-finish", reason: "tool-calls" } }),
      normalizeMimoEvent({ type: "unexpected_shape", value: true })
    ]);

    expect(summary).toMatchObject({
      messages: 0,
      tools: 0,
      diffs: 0,
      errors: 0,
      progress: 2,
      raw: 1
    });
  });
});
