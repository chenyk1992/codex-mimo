import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";

export interface VerificationResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  passed: boolean;
  durationMs: number;
}

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
  commands: string[]
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  for (const command of commands) {
    const startedAt = Date.now();
    try {
      const parts = command.split(/\s+/).filter(Boolean);
      const [file, ...args] = parts;
      const result = await execa(file, args, {
        cwd,
        reject: false
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
      results.push({
        command,
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        passed: false,
        durationMs: Date.now() - startedAt
      });
    }
  }

  return results;
}
