import { execa } from "execa";

export interface GitStatusSnapshot {
  short: string;
  dirty: boolean;
}

export async function captureGitStatus(cwd: string): Promise<GitStatusSnapshot> {
  const result = await execa("git", ["status", "--short"], { cwd, reject: false });
  return {
    short: result.stdout ?? "",
    dirty: (result.stdout ?? "").trim().length > 0
  };
}

export interface GitDiffSnapshot {
  changedFiles: string[];
  diffStat: string;
  diff: string;
}

export function parseChangedFiles(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function captureGitDiff(cwd: string, base = "HEAD"): Promise<GitDiffSnapshot> {
  const [names, stat, diff] = await Promise.all([
    execa("git", ["diff", "--name-only", base], { cwd }),
    execa("git", ["diff", "--stat", base], { cwd }),
    execa("git", ["diff", base], { cwd })
  ]);

  return {
    changedFiles: parseChangedFiles(names.stdout),
    diffStat: stat.stdout,
    diff: diff.stdout
  };
}

