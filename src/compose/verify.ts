import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";
import { withUtf8ProcessEnv } from "../core/encoding.js";
import { errorMessage } from "../core/errors.js";
import type { JobVerification } from "../core/jobs.js";

export interface VerificationResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  passed: boolean;
  durationMs: number;
}

export interface VerificationRunOptions {
  signal?: AbortSignal;
  execute?: VerificationCommandExecutor;
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

function detectVerificationCommands(cwd: string): string[] {
  if (fs.existsSync(path.join(cwd, "pyproject.toml"))) return ["python -m pytest"];
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) return ["cargo test"];
  if (fs.existsSync(path.join(cwd, "go.mod"))) return ["go test ./..."];
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

export async function runVerificationCommands(
  cwd: string,
  commands: string[],
  options: VerificationRunOptions = {}
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  const execute: VerificationCommandExecutor = options.execute ?? (
    (file, args, executeOptions) => execa(file, args, executeOptions)
  );

  for (const command of commands) {
    options.signal?.throwIfAborted();
    const startedAt = Date.now();
    try {
      const parts = command.split(/\s+/).filter(Boolean);
      const [file, ...args] = parts;
      const result = await execute(file, args, {
        cwd,
        reject: false,
        env: withUtf8ProcessEnv(),
        cancelSignal: options.signal
      });
      results.push({
        command,
        exitCode: result.exitCode ?? null,
        stdout: result.stdout,
        stderr: result.stderr,
        passed: result.exitCode === 0,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      options.signal?.throwIfAborted();
      results.push({
        command,
        exitCode: null,
        stdout: "",
        stderr: errorMessage(error),
        passed: false,
        durationMs: Date.now() - startedAt
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
