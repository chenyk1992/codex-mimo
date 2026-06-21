import { execa } from "execa";

export interface VerificationResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  passed: boolean;
  durationMs: number;
}

export function normalizeVerificationCommands(
  explicit: string[] | undefined,
  defaults: string[]
): string[] {
  return explicit && explicit.length > 0 ? explicit : defaults;
}

export async function runVerificationCommands(
  cwd: string,
  commands: string[]
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  for (const command of commands) {
    const startedAt = Date.now();
    try {
      const result = await execa(command, {
        cwd,
        shell: true,
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
