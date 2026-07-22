import { existsSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { withUtf8ProcessEnv } from "../core/encoding.js";

export const CODEX_COMMAND_ENV = "CODEX_MIMO_CODEX_BIN";

export interface CodexCommandSelection {
  command: string;
  source: "configured" | "path";
}

export function resolveCodexCommand(
  env: NodeJS.ProcessEnv = process.env
): CodexCommandSelection {
  const configured = env[CODEX_COMMAND_ENV]?.trim();
  return configured
    ? { command: configured, source: "configured" }
    : { command: "codex", source: "path" };
}

export type CodexCommandErrorCode =
  | "codex_cli_not_found"
  | "codex_cli_not_executable"
  | "codex_app_server_unavailable";

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function osErrorCode(error: unknown): string | undefined {
  const record = recordValue(error);
  if (!record) return undefined;
  if (typeof record.code === "string") return record.code;

  const cause = recordValue(record.cause);
  return typeof cause?.code === "string" ? cause.code : undefined;
}

export function codexCommandErrorCode(error: unknown): CodexCommandErrorCode {
  const code = osErrorCode(error);
  if (code === "ENOENT") return "codex_cli_not_found";
  if (code === "EPERM" || code === "EACCES") return "codex_cli_not_executable";
  return "codex_app_server_unavailable";
}

/** True when `command` is path-like (not a bare PATH token). */
function isPathCommand(command: string): boolean {
  return path.isAbsolute(command)
    || command.includes("/")
    || command.includes("\\");
}

/**
 * Windows Execa (via cross-spawn -> cmd.exe) often reports missing executables as
 * exitCode 1 with no OS `code`/`cause`. When the configured command is an explicit
 * filesystem path that does not exist, treat that as ENOENT for classification only.
 * Bare PATH tokens are left alone so an existing-but-unrunnable PATH hit (EPERM)
 * is not misread as not-found.
 */
function pathCommandMissing(command: string): boolean {
  if (!isPathCommand(command)) return false;
  if (existsSync(command)) return false;
  if (process.platform === "win32" && path.extname(command) === "") {
    const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";");
    for (const ext of extensions) {
      if (!ext) continue;
      if (existsSync(command + ext)) return false;
    }
  }
  return true;
}

export interface CodexCommandProbe {
  ok: boolean;
  source: CodexCommandSelection["source"];
  version?: string;
  errorCode?: CodexCommandErrorCode;
}

export interface CodexCommandExecutionResult {
  exitCode?: number | null;
  stdout?: string;
  code?: unknown;
  cause?: unknown;
}

export interface CodexCommandProbeOptions {
  env?: NodeJS.ProcessEnv;
  execute?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; reject: false; timeout: number }
  ) => PromiseLike<CodexCommandExecutionResult>;
}

function classifyProbeFailure(
  error: unknown,
  command: string
): CodexCommandErrorCode {
  const classified = codexCommandErrorCode(error);
  if (
    classified === "codex_app_server_unavailable"
    && pathCommandMissing(command)
  ) {
    return codexCommandErrorCode({ code: "ENOENT" });
  }
  return classified;
}

export async function probeCodexCommand(
  options: CodexCommandProbeOptions = {}
): Promise<CodexCommandProbe> {
  const env = options.env ?? process.env;
  const selection = resolveCodexCommand(env);
  const execute = options.execute ?? ((command, args, executeOptions) =>
    execa(command, args, executeOptions));
  try {
    const result = await execute(selection.command, ["--version"], {
      env: withUtf8ProcessEnv(env),
      reject: false,
      timeout: 10_000
    });
    if (result.exitCode === 0) {
      const version = typeof result.stdout === "string" ? result.stdout.trim() : "";
      return { ok: true, source: selection.source, version };
    }
    return {
      ok: false,
      source: selection.source,
      errorCode: classifyProbeFailure(result, selection.command)
    };
  } catch (error) {
    return {
      ok: false,
      source: selection.source,
      errorCode: classifyProbeFailure(error, selection.command)
    };
  }
}
