import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_COMMAND_ENV,
  codexCommandErrorCode,
  probeCodexCommand,
  resolveCodexCommand
} from "../../../src/notify/codex-command.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

/** Place a fake `codex` on PATH so bare-token probes reach execute. */
function pathEnvWithFakeCodex(): { absolute: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-path-probe-"));
  temporaryRoots.push(dir);
  const absolute = path.join(dir, process.platform === "win32" ? "codex.cmd" : "codex");
  writeFileSync(absolute, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
  return {
    absolute,
    env: {
      PATH: dir,
      Path: dir,
      PATHEXT: ".CMD;.EXE;.BAT;.COM"
    }
  };
}

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
      path.normalize("C:\\Tools\\codex.cmd"),
      ["--version"],
      expect.objectContaining({ reject: false, timeout: 10_000 })
    );
  });

  it("reports PATH success via resolved absolute path without leaking it", async () => {
    const { absolute, env } = pathEnvWithFakeCodex();
    const execute = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "codex 1.0\n" });
    const result = await probeCodexCommand({ env, execute });
    expect(result).toEqual({
      ok: true,
      source: "path",
      version: "codex 1.0"
    });
    expect(execute.mock.calls[0]?.[0]?.toLowerCase()).toBe(absolute.toLowerCase());
    expect(execute.mock.calls[0]?.[1]).toEqual(["--version"]);
    expect(JSON.stringify(result).toLowerCase()).not.toContain(absolute.toLowerCase());
  });

  it("returns not_found for a bare missing PATH token without executing", async () => {
    const execute = vi.fn();
    const result = await probeCodexCommand({
      env: { PATH: "", Path: "", PATHEXT: ".EXE;.CMD;.BAT;.COM" },
      execute
    });
    expect(result).toEqual({
      ok: false,
      source: "path",
      errorCode: "codex_cli_not_found"
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["ENOENT", "codex_cli_not_found"],
    ["EPERM", "codex_cli_not_executable"],
    ["EACCES", "codex_cli_not_executable"]
  ] as const)("classifies resolved Execa cause %s as %s", async (osCode, errorCode) => {
    const { absolute, env } = pathEnvWithFakeCodex();
    const privatePath = "C:\\private\\WindowsApps\\codex.exe";
    const execute = vi.fn().mockResolvedValue({
      failed: true,
      exitCode: undefined,
      stdout: "",
      code: undefined,
      cause: Object.assign(new Error(privatePath), { code: osCode })
    });

    const result = await probeCodexCommand({ env, execute });

    expect(result).toEqual({ ok: false, source: "path", errorCode });
    expect(JSON.stringify(result)).not.toContain(privatePath);
    expect(JSON.stringify(result).toLowerCase()).not.toContain(absolute.toLowerCase());
    expect(execute.mock.calls[0]?.[0]?.toLowerCase()).toBe(absolute.toLowerCase());
  });

  it("classifies ENOENT without leaking private details", async () => {
    const { absolute, env } = pathEnvWithFakeCodex();
    const execute = vi.fn().mockRejectedValue(Object.assign(new Error("private path"), { code: "ENOENT" }));
    const result = await probeCodexCommand({ env, execute });
    expect(result).toEqual({ ok: false, source: "path", errorCode: "codex_cli_not_found" });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result).toLowerCase()).not.toContain(absolute.toLowerCase());
  });

  it("classifies EPERM without leaking absolute paths", async () => {
    const { absolute, env } = pathEnvWithFakeCodex();
    const execute = vi.fn().mockRejectedValue(Object.assign(
      new Error("C:\\Program Files\\WindowsApps\\codex.exe"),
      { code: "EPERM" }
    ));
    const result = await probeCodexCommand({ env, execute });
    expect(result).toEqual({ ok: false, source: "path", errorCode: "codex_cli_not_executable" });
    expect(JSON.stringify(result)).not.toContain("WindowsApps");
    expect(JSON.stringify(result).toLowerCase()).not.toContain(absolute.toLowerCase());
  });

  it("reports an ordinary non-zero version exit as app server unavailable", async () => {
    const { absolute, env } = pathEnvWithFakeCodex();
    const execute = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "private output" });
    const result = await probeCodexCommand({ env, execute });

    expect(result).toEqual({
      ok: false,
      source: "path",
      errorCode: "codex_app_server_unavailable"
    });
    expect(JSON.stringify(result)).not.toContain("private output");
    expect(JSON.stringify(result).toLowerCase()).not.toContain(absolute.toLowerCase());
  });

  it("does not serialize configured or resolved absolute paths in probe results", async () => {
    const configuredPath = "C:\\private\\configured\\codex.exe";
    const execute = vi.fn().mockResolvedValue({
      failed: true,
      exitCode: undefined,
      cause: Object.assign(new Error(configuredPath), { code: "EPERM" })
    });
    const result = await probeCodexCommand({
      env: { [CODEX_COMMAND_ENV]: configuredPath },
      execute
    });
    expect(result).toEqual({
      ok: false,
      source: "configured",
      errorCode: "codex_cli_not_executable"
    });
    expect(JSON.stringify(result)).not.toContain(configuredPath);
    expect(JSON.stringify(result)).not.toContain("private");
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