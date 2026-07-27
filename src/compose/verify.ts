import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";
import { withUtf8ProcessEnv } from "../core/encoding.js";
import type { JobVerification } from "../core/jobs.js";
import type { VerificationFailureKind, CommandResolutionSource } from "../core/safety-contracts.js";
import {
  buildCommandNotFoundMessage,
  classifyVerificationFailure,
  resolveVerificationCommand,
  type CommandResolutionDeps
} from "./command-resolution.js";

export interface VerificationResult {
  requestedCommand?: string;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  passed: boolean;
  durationMs: number;
  failureKind?: VerificationFailureKind;
}

export interface VerificationRunOptions extends CommandResolutionDeps {
  signal?: AbortSignal;
  execute?: VerificationCommandExecutor;
  platform?: NodeJS.Platform;
  source?: CommandResolutionSource;
}

export type VerificationCommandExecutor = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    reject: false;
    env: NodeJS.ProcessEnv;
    cancelSignal?: AbortSignal;
  }
) => PromiseLike<{
  exitCode?: number | null;
  stdout: string;
  stderr: string;
}>;

export function detectVerificationCommands(cwd: string): string[] {
  if (fs.existsSync(path.join(cwd, "pyproject.toml"))) return ["python -m pytest"];
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) return ["cargo test"];
  if (fs.existsSync(path.join(cwd, "go.mod"))) return ["go test ./..."];
  if (fs.existsSync(path.join(cwd, "pom.xml"))) return ["mvn test"];
  if (fs.existsSync(path.join(cwd, "package.json"))) return ["npm test"];
  return [];
}

export function normalizeVerificationCommands(
  explicit: string[] | undefined,
  defaults: string[],
  cwd?: string
): string[] {
  if (explicit && explicit.length > 0) return explicit;
  if (defaults.length > 0) return defaults;
  return cwd ? detectVerificationCommands(cwd) : [];
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function runVerificationCommands(
  cwd: string,
  commands: string[],
  options: VerificationRunOptions = {}
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  const execute: VerificationCommandExecutor = options.execute ?? (
    (file, args, executeOptions) => execa(file, args, executeOptions)
  );
  const resolutionDeps: CommandResolutionDeps = {
    exists: options.exists,
    isExecutable: options.isExecutable
  };

  for (const command of commands) {
    options.signal?.throwIfAborted();
    const startedAt = Date.now();
    const resolved = resolveVerificationCommand({
      cwd,
      command,
      platform: options.platform,
      source: options.source,
      ...resolutionDeps
    });

    try {
      const result = await execute(resolved.file, resolved.args, {
        cwd,
        reject: false,
        env: withUtf8ProcessEnv(),
        cancelSignal: options.signal
      });
      const passed = result.exitCode === 0;
      const failureKind = passed
        ? undefined
        : classifyVerificationFailure({ exitCode: result.exitCode ?? null });
      let stderr = result.stderr;
      if (failureKind === "command_not_found") {
        const message = buildCommandNotFoundMessage({
          resolved,
          cwd,
          platform: options.platform,
          exists: options.exists
        });
        stderr = stderr ? `${stderr}\n${message}` : message;
      }

      results.push({
        requestedCommand: resolved.requestedCommand,
        command: resolved.executedCommand,
        exitCode: result.exitCode ?? null,
        stdout: result.stdout,
        stderr,
        passed,
        durationMs: Date.now() - startedAt,
        failureKind
      });
    } catch (error) {
      if (isAbortError(error)) {
        options.signal?.throwIfAborted();
        results.push({
          requestedCommand: resolved.requestedCommand,
          command: resolved.executedCommand,
          exitCode: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          passed: false,
          durationMs: Date.now() - startedAt,
          failureKind: "aborted"
        });
        continue;
      }

      const failureKind = classifyVerificationFailure({ error });
      const stderr =
        failureKind === "command_not_found"
          ? buildCommandNotFoundMessage({
              resolved,
              cwd,
              platform: options.platform,
              exists: options.exists
            })
          : error instanceof Error
            ? error.message
            : String(error);

      results.push({
        requestedCommand: resolved.requestedCommand,
        command: resolved.executedCommand,
        exitCode: null,
        stdout: "",
        stderr,
        passed: false,
        durationMs: Date.now() - startedAt,
        failureKind
      });
    }
  }

  return results;
}

export function compactVerification(results: VerificationResult[]): JobVerification[] {
  return results.map(({ command, exitCode, passed, durationMs }) => ({
    command,
    exitCode,
    passed,
    durationMs
  }));
}

export { preflightVerificationCommand, resolveVerificationCommand } from "./command-resolution.js";
