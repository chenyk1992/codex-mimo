import { describe, expect, it } from "vitest";
import { resolveMimoCommand } from "../../src/mimo/run-json.js";

describe("resolveMimoCommand", () => {
  it("uses mimo by default", () => {
    expect(resolveMimoCommand({})).toBe("mimo");
  });

  it("uses CODEX_MIMO_COMMAND before MIMO_COMMAND", () => {
    expect(resolveMimoCommand({
      CODEX_MIMO_COMMAND: "C:/tools/mimo.cmd",
      MIMO_COMMAND: "mimo-alt"
    })).toBe("C:/tools/mimo.cmd");
  });

  it("uses MIMO_COMMAND when CODEX_MIMO_COMMAND is not set", () => {
    expect(resolveMimoCommand({ MIMO_COMMAND: "mimo-local" })).toBe("mimo-local");
  });
});
