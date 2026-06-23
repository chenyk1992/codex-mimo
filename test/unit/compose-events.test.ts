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
    expect(summarizeEvents(events)).toEqual({
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
});
