import { describe, expect, it } from "vitest";
import {
  CODEX_COMMAND_ENV,
  resolveCodexCommand
} from "../../../src/notify/codex-command.js";

describe("Codex command selection", () => {
  it("prefers the configured executable path", () => {
    expect(resolveCodexCommand({
      [CODEX_COMMAND_ENV]: " C:\\Tools\\codex.cmd "
    })).toEqual({ command: "C:\\Tools\\codex.cmd", source: "configured" });
  });

  it("falls back to PATH without invoking a shell", () => {
    expect(resolveCodexCommand({})).toEqual({ command: "codex", source: "path" });
  });

  it("ignores an empty configured value", () => {
    expect(resolveCodexCommand({ [CODEX_COMMAND_ENV]: "   " }))
      .toEqual({ command: "codex", source: "path" });
  });
});
