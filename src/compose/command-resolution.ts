import fs from "node:fs";
import path from "node:path";

import type {
  CommandResolutionKind,
  CommandResolutionSource,
  VerificationFailureKind
} from "../core/safety-contracts.js";

export interface ResolvedVerificationCommand {
  requestedCommand: string;
  executedCommand: string;
  file: string;
  args: string[];
  source: CommandResolutionSource;
  resolution: CommandResolutionKind;
}

export type CommandPreflightResult =
  | { ok: true; resolved: ResolvedVerificationCommand }
  | {
      ok: false;
      errorCode: "acceptance_command_unavailable";
      message: string;
      suggestion?: string;
    };

export interface CommandResolutionDeps {
  exists?: (filePath: string) => boolean;
  isExecutable?: (filePath: string) => boolean;
}

export interface ResolveVerificationCommandInput extends CommandResolutionDeps {
  cwd: string;
  command: string;
  platform?: NodeJS.Platform;
  source?: CommandResolutionSource;
}

export interface PreflightVerificationCommandInput extends ResolveVerificationCommandInput {
  pathLookup?: (command: string) => Promise<string | undefined>;
}

function defaultExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function defaultIsExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";

  for (const ch of command) {
    if (inQuotes) {
      if (ch === quoteChar) {
        inQuotes = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuotes = true;
      quoteChar = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function formatExecutedCommand(file: string, args: string[]): string {
  const quote = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);
  return [file, ...args].map(quote).join(" ");
}

/** True when the entry token is path-like and must not be rewritten to a wrapper. */
function isPathEntry(entry: string): boolean {
  return (
    path.isAbsolute(entry) ||
    entry.startsWith("./") ||
    entry.startsWith(".\\") ||
    entry.includes("/") ||
    entry.includes("\\")
  );
}

function resolveMavenWrapper(
  cwd: string,
  platform: NodeJS.Platform,
  exists: (filePath: string) => boolean
): { file: string; resolution: "maven_wrapper" } | undefined {
  if (platform === "win32") {
    const wrapperPath = path.join(cwd, "mvnw.cmd");
    if (exists(wrapperPath)) {
      return { file: wrapperPath, resolution: "maven_wrapper" };
    }
    return undefined;
  }

  const wrapperPath = path.join(cwd, "mvnw");
  if (exists(wrapperPath)) {
    return { file: "./mvnw", resolution: "maven_wrapper" };
  }
  return undefined;
}

function resolveGradleWrapper(
  cwd: string,
  platform: NodeJS.Platform,
  exists: (filePath: string) => boolean
): { file: string; resolution: "gradle_wrapper" } | undefined {
  if (platform === "win32") {
    const wrapperPath = path.join(cwd, "gradlew.bat");
    if (exists(wrapperPath)) {
      return { file: wrapperPath, resolution: "gradle_wrapper" };
    }
    return undefined;
  }

  const wrapperPath = path.join(cwd, "gradlew");
  if (exists(wrapperPath)) {
    return { file: "./gradlew", resolution: "gradle_wrapper" };
  }
  return undefined;
}

function wrapperAvailabilityMessage(
  tool: "mvn" | "gradle",
  cwd: string,
  platform: NodeJS.Platform,
  exists: (filePath: string) => boolean
): string | undefined {
  if (tool === "mvn") {
    const wrapper = resolveMavenWrapper(cwd, platform, exists);
    if (!wrapper) {
      return undefined;
    }
    const wrapperName = platform === "win32" ? "mvnw.cmd" : "mvnw";
    return `Global "mvn" was not found; repository wrapper "${wrapperName}" is available and should be used.`;
  }

  const wrapper = resolveGradleWrapper(cwd, platform, exists);
  if (!wrapper) {
    return undefined;
  }
  const wrapperName = platform === "win32" ? "gradlew.bat" : "gradlew";
  return `Global "gradle" was not found; repository wrapper "${wrapperName}" is available and should be used.`;
}

export function resolveVerificationCommand(
  input: ResolveVerificationCommandInput
): ResolvedVerificationCommand {
  const platform = input.platform ?? process.platform;
  const exists = input.exists ?? defaultExists;
  const source = input.source ?? "detected";
  const requestedCommand = input.command.trim();
  const tokens = tokenizeCommand(requestedCommand);
  const [entry = "", ...args] = tokens;

  if (!entry) {
    return {
      requestedCommand,
      executedCommand: requestedCommand,
      file: "",
      args: [],
      source,
      resolution: "unchanged"
    };
  }

  const entryBase = path.basename(entry).toLowerCase();
  let file = entry;
  let resolution: CommandResolutionKind = "unchanged";

  if (!isPathEntry(entry)) {
    if (entryBase === "mvn") {
      const wrapper = resolveMavenWrapper(input.cwd, platform, exists);
      if (wrapper) {
        file = wrapper.file;
        resolution = wrapper.resolution;
      }
    } else if (entryBase === "gradle") {
      const wrapper = resolveGradleWrapper(input.cwd, platform, exists);
      if (wrapper) {
        file = wrapper.file;
        resolution = wrapper.resolution;
      }
    }
  }

  const executedCommand = formatExecutedCommand(file, args);
  return {
    requestedCommand,
    executedCommand,
    file,
    args,
    source,
    resolution
  };
}

function osErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const record = error as { code?: unknown; cause?: unknown };
  if (typeof record.code === "string") {
    return record.code;
  }
  if (typeof record.cause === "object" && record.cause !== null) {
    const cause = record.cause as { code?: unknown };
    if (typeof cause.code === "string") {
      return cause.code;
    }
  }
  return undefined;
}

export function classifyVerificationFailure(input: {
  error?: unknown;
  exitCode?: number | null;
  aborted?: boolean;
}): VerificationFailureKind | undefined {
  if (input.aborted) {
    return "aborted";
  }
  if (osErrorCode(input.error) === "ENOENT") {
    return "command_not_found";
  }
  if (input.exitCode !== 0 && input.exitCode !== null && input.exitCode !== undefined) {
    return "exit_nonzero";
  }
  if (input.exitCode === null || input.exitCode === undefined) {
    return "command_not_found";
  }
  return undefined;
}

export function buildCommandNotFoundMessage(input: {
  resolved: ResolvedVerificationCommand;
  cwd: string;
  platform?: NodeJS.Platform;
  exists?: (filePath: string) => boolean;
}): string {
  const platform = input.platform ?? process.platform;
  const exists = input.exists ?? defaultExists;
  const entry = path.basename(tokenizeCommand(input.resolved.requestedCommand)[0] ?? "");
  const entryBase = entry.toLowerCase();

  if (entryBase === "mvn") {
    return (
      wrapperAvailabilityMessage("mvn", input.cwd, platform, exists) ??
      `Command "${input.resolved.requestedCommand}" was not found.`
    );
  }
  if (entryBase === "gradle") {
    return (
      wrapperAvailabilityMessage("gradle", input.cwd, platform, exists) ??
      `Command "${input.resolved.requestedCommand}" was not found.`
    );
  }

  return `Command "${input.resolved.requestedCommand}" was not found.`;
}

export async function preflightVerificationCommand(
  input: PreflightVerificationCommandInput
): Promise<CommandPreflightResult> {
  const platform = input.platform ?? process.platform;
  const exists = input.exists ?? defaultExists;
  const isExecutable = input.isExecutable ?? defaultIsExecutable;
  const resolved = resolveVerificationCommand(input);

  if (!resolved.file) {
    return {
      ok: false,
      errorCode: "acceptance_command_unavailable",
      message: "Verification command is empty or missing an executable entry."
    };
  }

  if (resolved.resolution === "maven_wrapper" || resolved.resolution === "gradle_wrapper") {
    const wrapperPath =
      resolved.file.startsWith("./") || resolved.file.startsWith(".\\")
        ? path.join(input.cwd, resolved.file.slice(2))
        : resolved.file;

    if (!exists(wrapperPath)) {
      return {
        ok: false,
        errorCode: "acceptance_command_unavailable",
        message: `Repository wrapper "${path.basename(wrapperPath)}" is missing.`
      };
    }

    if (platform !== "win32" && !isExecutable(wrapperPath)) {
      return {
        ok: false,
        errorCode: "acceptance_command_unavailable",
        message: `Repository wrapper "${path.basename(wrapperPath)}" is not executable.`,
        suggestion: `Run chmod +x ${path.basename(wrapperPath)} and retry.`
      };
    }

    return { ok: true, resolved };
  }

  if (isPathEntry(resolved.file)) {
    if (!exists(path.isAbsolute(resolved.file) ? resolved.file : path.join(input.cwd, resolved.file))) {
      return {
        ok: false,
        errorCode: "acceptance_command_unavailable",
        message: `Command entry "${resolved.file}" was not found in the workspace.`
      };
    }
    return { ok: true, resolved };
  }

  const pathLookup = input.pathLookup ?? (async () => undefined);
  const located = await pathLookup(resolved.file);
  if (!located) {
    const entryBase = path.basename(resolved.file).toLowerCase();
    const suggestion =
      entryBase === "mvn"
        ? wrapperAvailabilityMessage("mvn", input.cwd, platform, exists)
        : entryBase === "gradle"
          ? wrapperAvailabilityMessage("gradle", input.cwd, platform, exists)
          : undefined;

    return {
      ok: false,
      errorCode: "acceptance_command_unavailable",
      message: `Command "${resolved.file}" was not found on PATH.`,
      ...(suggestion ? { suggestion } : {})
    };
  }

  return { ok: true, resolved };
}
