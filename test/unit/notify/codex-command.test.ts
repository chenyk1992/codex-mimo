import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
      PATHEXT: ".cmd;.exe;.bat;.com"
    }
  };
}

function createDesktopLocalCodex(): {
  bin: string;
  root: string;
  versions: { newer: string; older: string };
  env: NodeJS.ProcessEnv;
} {
  const localAppData = mkdtempSync(path.join(os.tmpdir(), "codex-desktop-local-"));
  temporaryRoots.push(localAppData);
  const bin = path.join(localAppData, "OpenAI", "Codex", "bin");
  const root = path.join(bin, "codex.exe");
  const newer = path.join(bin, "newer", "codex.exe");
  const older = path.join(bin, "older", "codex.exe");
  for (const executable of [root, newer, older]) {
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "");
  }
  utimesSync(path.dirname(newer), new Date("2026-01-02T00:00:00.000Z"), new Date("2026-01-02T00:00:00.000Z"));
  utimesSync(path.dirname(older), new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
  return {
    bin,
    root,
    versions: { newer, older },
    env: { LOCALAPPDATA: localAppData, PATH: "", Path: "", PATHEXT: ".exe" }
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
  it("falls through failed PATH hits until a later candidate succeeds", async () => {
    const first = pathEnvWithFakeCodex();
    const second = pathEnvWithFakeCodex();
    const execute = vi.fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "codex 1.2\n" });

    const result = await probeCodexCommand({
      env: { ...first.env, PATH: `${first.env.PATH}${path.delimiter}${second.env.PATH}` },
      execute
    });

    expect(result).toEqual({ ok: true, source: "path", version: "codex 1.2" });
    expect(execute.mock.calls.map(([command]) => command)).toEqual([first.absolute, second.absolute]);
    expect(JSON.stringify(result)).not.toContain(first.absolute);
    expect(JSON.stringify(result)).not.toContain(second.absolute);
  });

  it("discovers Desktop-local version folders newest first before the root binary", async () => {
    const desktop = createDesktopLocalCodex();
    const execute = vi.fn()
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "codex Desktop\n" });

    const result = await probeCodexCommand({ env: desktop.env, platform: "win32", execute });

    expect(result).toEqual({ ok: true, source: "desktop-local", version: "codex Desktop" });
    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      desktop.versions.newer,
      desktop.versions.older,
      desktop.root
    ]);
    expect(JSON.stringify(result)).not.toContain(desktop.bin);
  });

  it("de-duplicates normalized PATH and Desktop-local candidates", async () => {
    const desktop = createDesktopLocalCodex();
    const duplicateBin = `${desktop.bin}${path.sep}..${path.sep}${path.basename(desktop.bin)}`;
    const execute = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "" });

    await probeCodexCommand({
      env: { ...desktop.env, PATH: duplicateBin, Path: duplicateBin },
      platform: "win32",
      execute
    });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      desktop.root,
      desktop.versions.newer,
      desktop.versions.older
    ]);
  });

  it("does not discover Desktop-local candidates on non-Windows platforms", async () => {
    const desktop = createDesktopLocalCodex();
    const execute = vi.fn();

    const result = await probeCodexCommand({ env: desktop.env, platform: "linux", execute });

    expect(result).toEqual({
      ok: false,
      source: "path",
      errorCode: "codex_cli_not_found"
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not fall back when the configured override fails", async () => {
    const { absolute, env } = pathEnvWithFakeCodex();
    const configured = path.join(path.dirname(absolute), "configured-codex");
    const execute = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "" });

    const result = await probeCodexCommand({
      env: { ...env, [CODEX_COMMAND_ENV]: configured },
      execute
    });

    expect(result).toEqual({
      ok: false,
      source: "configured",
      errorCode: "codex_cli_not_found"
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toBe(path.normalize(configured));
    expect(execute.mock.calls[0]?.[0]).not.toBe(absolute);
    expect(JSON.stringify(result)).not.toContain(configured);
  });

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
