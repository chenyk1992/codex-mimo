import { execa } from "execa";
import path from "node:path";

export interface GitStatusSnapshot {
  short: string;
  dirty: boolean;
}

export interface GitHeadSnapshot {
  oid: string;
  short: string;
  subject: string;
}

export interface GitCommitChangeSnapshot {
  commits: string[];
  changedFiles: string[];
}

export async function captureGitStatus(cwd: string): Promise<GitStatusSnapshot> {
  const result = await execa("git", gitArgs(cwd, ["status", "--short"]), { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`Git status capture failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  }
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
    execa("git", gitArgs(cwd, ["diff", "--name-only", base]), { cwd }),
    execa("git", gitArgs(cwd, ["diff", "--stat", base]), { cwd }),
    execa("git", gitArgs(cwd, ["diff", base]), { cwd })
  ]);

  return {
    changedFiles: parseChangedFiles(names.stdout),
    diffStat: stat.stdout,
    diff: diff.stdout
  };
}

export async function captureGitHead(cwd: string): Promise<GitHeadSnapshot> {
  const oid = await execa("git", gitArgs(cwd, ["rev-parse", "--verify", "HEAD"]), { cwd, reject: false });
  if (oid.exitCode !== 0) {
    throw new Error(`Git HEAD capture failed: ${oid.stderr || oid.stdout || `exit ${oid.exitCode}`}`);
  }
  const summary = await execa("git", gitArgs(cwd, ["log", "-1", "--format=%h %s"]), { cwd });
  const { short, subject } = parseHeadSummary(summary.stdout);
  return {
    oid: oid.stdout.trim(),
    short,
    subject
  };
}

export async function captureGitCommitChanges(
  cwd: string,
  before: GitHeadSnapshot | undefined,
  after: GitHeadSnapshot | undefined
): Promise<GitCommitChangeSnapshot> {
  if (!before || !after || before.oid === after.oid) {
    return { commits: [], changedFiles: [] };
  }
  const [commits, files] = await Promise.all([
    execa("git", gitArgs(cwd, ["log", "--oneline", "--reverse", `${before.oid}..${after.oid}`]), { cwd }),
    execa("git", gitArgs(cwd, ["diff", "--name-only", before.oid, after.oid]), { cwd })
  ]);
  return {
    commits: parseChangedFiles(commits.stdout),
    changedFiles: parseChangedFiles(files.stdout)
  };
}

function gitArgs(cwd: string, args: string[]): string[] {
  return ["-c", `safe.directory=${safeDirectory(cwd)}`, ...args];
}

function safeDirectory(cwd: string): string {
  const absolute = path.isAbsolute(cwd) || /^[a-zA-Z]:[\\/]/.test(cwd)
    ? cwd
    : path.resolve(cwd);
  return absolute.replace(/\\/g, "/");
}

function parseHeadSummary(summary: string): { short: string; subject: string } {
  const trimmed = summary.trim();
  const split = trimmed.indexOf(" ");
  if (split === -1) return { short: trimmed, subject: "" };
  return {
    short: trimmed.slice(0, split),
    subject: trimmed.slice(split + 1)
  };
}
