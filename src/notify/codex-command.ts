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

export function codexCommandErrorCode(error: unknown): CodexCommandErrorCode {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "codex_app_server_unavailable";
  }
  if (error.code === "ENOENT") return "codex_cli_not_found";
  if (error.code === "EPERM" || error.code === "EACCES") {
    return "codex_cli_not_executable";
  }
  return "codex_app_server_unavailable";
}

export interface CodexCommandProbe {
  ok: boolean;
  source: CodexCommandSelection["source"];
  version?: string;
  errorCode?: CodexCommandErrorCode;
}

export interface CodexCommandProbeOptions {
  env?: NodeJS.ProcessEnv;
  execute?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; reject: false; timeout: number }
  ) => PromiseLike<{ exitCode: number | null; stdout: string }>;
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
    return result.exitCode === 0
      ? { ok: true, source: selection.source, version: result.stdout.trim() }
      : {
          ok: false,
          source: selection.source,
          errorCode: "codex_app_server_unavailable"
        };
  } catch (error) {
    return {
      ok: false,
      source: selection.source,
      errorCode: codexCommandErrorCode(error)
    };
  }
}
