import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_COMMAND_ENV,
  codexCommandErrorCode,
  probeCodexCommand,
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

describe("Codex command error classification", () => {
  it.each([
    ["ENOENT", "codex_cli_not_found"],
    ["EPERM", "codex_cli_not_executable"],
    ["EACCES", "codex_cli_not_executable"],
    ["EEXIST", "codex_app_server_unavailable"]
  ] as const)("maps %s to %s", (osCode, errorCode) => {
    expect(codexCommandErrorCode(Object.assign(new Error("private path"), { code: osCode })))
      .toBe(errorCode);
  });

  it("maps unknown errors to unavailable", () => {
    expect(codexCommandErrorCode(new Error("private detail"))).toBe("codex_app_server_unavailable");
    expect(codexCommandErrorCode(null)).toBe("codex_app_server_unavailable");
  });

  it("classifies nested cause codes without inspecting messages", () => {
    expect(codexCommandErrorCode({
      code: undefined,
      cause: { code: "EPERM", message: "C:\\private\\codex.exe" }
    })).toBe("codex_cli_not_executable");
  });
});

describe("codexCommandErrorCode", () => {
  it.each([
    ["ENOENT", "codex_cli_not_found"],
    ["EPERM", "codex_cli_not_executable"],
    ["EACCES", "codex_cli_not_executable"]
  ] as const)("maps %s to %s", (osCode, errorCode) => {
    expect(codexCommandErrorCode(Object.assign(new Error("private"), { code: osCode })))
      .toBe(errorCode);
  });

  it("defaults unknown errors to codex_app_server_unavailable", () => {
    expect(codexCommandErrorCode(new Error("unexpected"))).toBe("codex_app_server_unavailable");
  });
});

describe("Codex command probe", () => {
  it("reports configured executable success", async () => {
    const execute = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "codex 1.2.3\n" });
    expect(await probeCodexCommand({
      env: { [CODEX_COMMAND_ENV]: "C:\\Tools\\codex.cmd" },
      execute
    })).toEqual({
      ok: true,
      source: "configured",
      version: "codex 1.2.3"
    });
    expect(execute).toHaveBeenCalledWith(
      "C:\\Tools\\codex.cmd",
      ["--version"],
      expect.objectContaining({ reject: false, timeout: 10_000 })
    );
  });

  it("reports PATH success", async () => {
    const execute = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "codex 1.0\n" });
    expect(await probeCodexCommand({ env: {}, execute })).toEqual({
      ok: true,
      source: "path",
      version: "codex 1.0"
    });
    expect(execute).toHaveBeenCalledWith("codex", ["--version"], expect.any(Object));
  });

  it.each([
    ["ENOENT", "codex_cli_not_found"],
    ["EPERM", "codex_cli_not_executable"],
    ["EACCES", "codex_cli_not_executable"]
  ] as const)("classifies resolved Execa cause %s as %s", async (osCode, errorCode) => {
    const privatePath = "C:\\private\\WindowsApps\\codex.exe";
    const execute = vi.fn().mockResolvedValue({
      failed: true,
      exitCode: undefined,
      stdout: "",
      code: undefined,
      cause: Object.assign(new Error(privatePath), { code: osCode })
    });

    const result = await probeCodexCommand({ env: {}, execute });

    expect(result).toEqual({ ok: false, source: "path", errorCode });
    expect(JSON.stringify(result)).not.toContain(privatePath);
  });

  it("classifies ENOENT without leaking private details", async () => {
    const execute = vi.fn().mockRejectedValue(Object.assign(new Error("private path"), { code: "ENOENT" }));
    const result = await probeCodexCommand({ env: {}, execute });
    expect(result).toEqual({ ok: false, source: "path", errorCode: "codex_cli_not_found" });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("classifies EPERM without leaking absolute paths", async () => {
    const execute = vi.fn().mockRejectedValue(Object.assign(
      new Error("C:\\Program Files\\WindowsApps\\codex.exe"),
      { code: "EPERM" }
    ));
    const result = await probeCodexCommand({ env: {}, execute });
    expect(result).toEqual({ ok: false, source: "path", errorCode: "codex_cli_not_executable" });
    expect(JSON.stringify(result)).not.toContain("WindowsApps");
  });

  it("reports an ordinary non-zero version exit as app server unavailable", async () => {
    const execute = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "private output" });
    const result = await probeCodexCommand({ env: {}, execute });

    expect(result).toEqual({
      ok: false,
      source: "path",
      errorCode: "codex_app_server_unavailable"
    });
    expect(JSON.stringify(result)).not.toContain("private output");
  });

  it("classifies a real reject:false missing executable without leaking its path", async () => {
    const privateMissingPath = path.join(
      os.tmpdir(),
      `private-codex-missing-${process.pid}-${Date.now()}`,
      "codex"
    );

    const result = await probeCodexCommand({
      env: { [CODEX_COMMAND_ENV]: privateMissingPath }
    });

    expect(result).toEqual({
      ok: false,
      source: "configured",
      errorCode: "codex_cli_not_found"
    });
    expect(JSON.stringify(result)).not.toContain(privateMissingPath);
  });
});
