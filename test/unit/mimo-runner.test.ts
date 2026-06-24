import { describe, expect, it } from "vitest";
import { parseMimoOutput } from "../../src/mimo/mimo-runner.js";

describe("parseMimoOutput", () => {
  it("recognizes sessionId and sessionID variants", () => {
    expect(parseMimoOutput([{ sessionID: "ses_upper" }]).sessionId).toBe("ses_upper");
    expect(parseMimoOutput([{ sessionId: "ses_camel" }]).sessionId).toBe("ses_camel");
  });

  it("captures changed files from write metadata and edit input paths", () => {
    const result = parseMimoOutput([
      {
        type: "tool_use",
        part: {
          tool: "write",
          state: { metadata: { filepath: ".codex-mimo/plugin-smoke/README.md" } }
        }
      },
      {
        type: "tool_use",
        part: {
          tool: "edit",
          state: { input: { filePath: "src/mimo/run-json.ts" } }
        }
      }
    ]);

    expect(result.changedFiles).toEqual([
      ".codex-mimo/plugin-smoke/README.md",
      "src/mimo/run-json.ts"
    ]);
  });

  it("captures top-level path fields on mutating tool parts", () => {
    const result = parseMimoOutput([
      {
        type: "tool_use",
        part: {
          tool: "edit",
          path: "src/codex/tools.ts",
          state: {}
        }
      }
    ]);

    expect(result.changedFiles).toEqual(["src/codex/tools.ts"]);
  });

  it("captures error messages from JSONL error events", () => {
    const result = parseMimoOutput([
      { type: "error", message: "model failed" },
      { type: "error", part: { text: "tool failed" } }
    ]);

    expect(result.errors).toEqual(["model failed", "tool failed"]);
  });

  it("parses tool_use with nested part.state for bash commands", () => {
    const result = parseMimoOutput([
      { type: "text", part: { text: "done" } },
      {
        type: "tool_use",
        part: {
          type: "tool",
          tool: "bash",
          state: {
            input: { command: "npm test" },
            metadata: { exit: 0 }
          }
        }
      }
    ]);

    expect(result.summary).toBe("done");
    expect(result.commands).toEqual([{ command: "npm test", exitCode: 0 }]);
  });
});
