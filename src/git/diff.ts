import { execa } from "execa";

export interface DiffResult {
  stat: string;
  diff: string;
  changedFiles: string[];
  hasChanges: boolean;
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

export async function captureDiff(cwd: string, base: string = "HEAD"): Promise<DiffResult> {
  const [statResult, diffResult, nameResult] = await Promise.all([
    execa("git", ["diff", "--stat", base], { cwd, reject: false }),
    execa("git", ["diff", base], { cwd, reject: false }),
    execa("git", ["diff", "--name-only", base], { cwd, reject: false })
  ]);

  const changedFiles = parseChangedFiles(nameResult.stdout ?? "");

  return {
    stat: statResult.stdout ?? "",
    diff: diffResult.stdout ?? "",
    changedFiles,
    hasChanges: changedFiles.length > 0
  };
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

export async function captureStatus(cwd: string): Promise<string> {
  const result = await execa("git", ["status", "--short"], { cwd, reject: false });
  return result.stdout ?? "";
}
