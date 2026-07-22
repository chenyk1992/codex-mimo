import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { withUtf8ProcessEnv } from "../core/encoding.js";

export const CODEX_COMMAND_ENV = "CODEX_MIMO_CODEX_BIN";

export interface CodexCommandSelection {
  command: string;
  source: "configured" | "path" | "desktop-local";
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

function commandNames(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string[] {
  const names = [command];
  if (platform !== "win32") return names;

  const pathext = env.PATHEXT ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  for (const ext of pathext.split(";")) {
    if (!ext) continue;
    const normalizedExt = ext.startsWith(".") ? ext : `.${ext}`;
    names.push(command + normalizedExt);
  }
  return names;
}

/** Resolve every existing bare-command PATH hit to normalized absolute paths. */
function resolvePathCandidates(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string[] {
  if (isPathCommand(command)) return [path.normalize(command)];

  const pathEnv = env.PATH ?? env.Path;
  if (!pathEnv) return [];

  const dirs = pathEnv.split(path.delimiter).filter((dir) => dir.length > 0);
  const names = commandNames(command, env, platform);
  const candidates: string[] = [];

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.resolve(dir, name);
      if (existsSync(candidate)) {
        candidates.push(path.normalize(candidate));
      }
    }
  }
  return candidates;
}

function desktopLocalCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string[] {
  if (platform !== "win32") return [];
  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData) return [];

  const bin = path.join(localAppData, "OpenAI", "Codex", "bin");
  const versions: { command: string; modified: number }[] = [];
  try {
    for (const entry of readdirSync(bin, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(bin, entry.name);
      const command = path.join(folder, "codex.exe");
      if (!existsSync(command)) continue;
      versions.push({ command: path.normalize(command), modified: statSync(folder).mtimeMs });
    }
  } catch {}

  versions.sort((left, right) => right.modified - left.modified);
  const candidates = versions.map(({ command }) => command);
  const root = path.join(bin, "codex.exe");
  if (existsSync(root)) candidates.push(path.normalize(root));
  return candidates;
}

function deDuplicateCandidates(
  candidates: CodexCommandSelection[],
  platform: NodeJS.Platform
): CodexCommandSelection[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = platform === "win32"
      ? candidate.command.toLowerCase()
      : candidate.command;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function discoverCodexCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): CodexCommandSelection[] {
  const configured = env[CODEX_COMMAND_ENV]?.trim();
  if (configured) {
    const candidates = resolvePathCandidates(configured, env, platform);
    return candidates.map((command) => ({ command, source: "configured" }));
  }

  return deDuplicateCandidates([
    ...resolvePathCandidates("codex", env, platform)
      .map((command) => ({ command, source: "path" as const })),
    ...desktopLocalCandidates(env, platform)
      .map((command) => ({ command, source: "desktop-local" as const }))
  ], platform);
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
  /** Test-only platform override; production probes use the current platform. */
  platform?: NodeJS.Platform;
  execute?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; reject: false; timeout: number }
  ) => PromiseLike<CodexCommandExecutionResult>;
}

export function classifyCodexCommandFailure(
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
  const platform = options.platform ?? process.platform;
  const selection = resolveCodexCommand(env);
  const candidates = discoverCodexCandidates(env, platform);
  if (candidates.length === 0) {
    return {
      ok: false,
      source: selection.source,
      errorCode: "codex_cli_not_found"
    };
  }

  const execute = options.execute ?? ((command, args, executeOptions) =>
    execa(command, args, executeOptions));
  let failure: CodexCommandProbe | undefined;
  for (const candidate of candidates) {
    try {
      const result = await execute(candidate.command, ["--version"], {
        env: withUtf8ProcessEnv(env),
        reject: false,
        timeout: 10_000
      });
      if (result.exitCode === 0) {
        const version = typeof result.stdout === "string" ? result.stdout.trim() : "";
        return { ok: true, source: candidate.source, version };
      }
      failure = {
        ok: false,
        source: candidate.source,
        errorCode: classifyCodexCommandFailure(result, candidate.command)
      };
    } catch (error) {
      failure = {
        ok: false,
        source: candidate.source,
        errorCode: classifyCodexCommandFailure(error, candidate.command)
      };
    }
    if (candidate.source === "configured") return failure;
  }
  return failure!;
}
