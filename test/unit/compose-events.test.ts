import { describe, expect, it } from "vitest";
import {
  extractPassingCommandEvidence,
  extractSessionIdFromEvents,
  extractToolUseWritePaths,
  normalizeMimoEvent,
  parseMimoJsonLines,
  summarizeEvents
} from "../../src/compose/events.js";

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

  it("extracts MiMo sessionID from raw events", () => {
    const events = [
      normalizeMimoEvent({
        type: "step_start",
        sessionID: "ses_upper",
        part: { type: "step-start", sessionID: "ses_part" }
      })
    ];

    expect(extractSessionIdFromEvents(events)).toBe("ses_upper");
  });

  it("extracts MiMo sessionId from nested part events", () => {
    const events = [
      normalizeMimoEvent({
        type: "tool_use",
        part: {
          type: "tool",
          tool: "read",
          sessionId: "ses_nested",
          state: { status: "completed", input: { file_path: "README.md" } }
        }
      })
    ];

    expect(extractSessionIdFromEvents(events)).toBe("ses_nested");
  });

  it("extracts canonical write paths without treating bash as a file write", () => {
    const events = parseMimoJsonLines([
      '{"type":"tool_use","part":{"type":"tool","tool":"write","state":{"input":{"file_path":"src/a.ts"}}}}',
      '{"type":"tool_use","part":{"type":"tool","tool":"edit","state":{"input":{"filePath":"src/b.ts"}}}}',
      '{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"metadata":{"exit":0},"input":{"command":"npm test"}}}}'
    ].join("\n"));

    expect(extractToolUseWritePaths(events)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("accepts only successful commands that ran after the last declared write", () => {
    const events = parseMimoJsonLines([
      '{"type":"tool_use","timestamp":"2026-07-29T00:00:00.000Z","part":{"type":"tool","tool":"bash","state":{"metadata":{"exit":0},"input":{"command":"npm test"}}}}',
      '{"type":"tool_use","part":{"type":"tool","tool":"edit","state":{"input":{"file_path":"src/a.ts"}}}}',
      '{"type":"tool_use","timestamp":"2026-07-29T00:01:00.000Z","part":{"type":"tool","tool":"bash","state":{"metadata":{"exit":"0"},"input":{"command":"npm test","cwd":"E:/repo"}}}}',
      '{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"metadata":{"exit":1},"input":{"command":"npm run build"}}}}'
    ].join("\n"));

    expect(extractPassingCommandEvidence(events, "E:/fallback")).toEqual([
      {
        command: "npm test",
        cwd: "E:/fallback",
        exitCode: 0,
        eventIndex: 0,
        afterLastWrite: false,
        timestamp: "2026-07-29T00:00:00.000Z"
      },
      {
        command: "npm test",
        cwd: "E:/repo",
        exitCode: 0,
        eventIndex: 2,
        afterLastWrite: true,
        timestamp: "2026-07-29T00:01:00.000Z"
      }
    ]);
  });
});
