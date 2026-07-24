import { execa } from "execa";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "../core/errors.js";

export interface GitFileFingerprint {
  status: string;
  contentHash: string;
}

export interface GitStatusSnapshot {
  short: string;
  dirty: boolean;
  fingerprints: Record<string, GitFileFingerprint>;
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

export interface GitCaptureOptions {
  signal?: AbortSignal;
}

export async function captureGitStatus(
  cwd: string,
  options: GitCaptureOptions = {}
): Promise<GitStatusSnapshot> {
  const result = await execa(
    "git",
    gitArgs(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    gitCommandOptions(cwd, options, false)
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
    // Empty `.git` placeholders / non-repo workspaces: treat as a clean snapshot so jobs can start.
    if (isMissingGitRepositoryError(detail)) {
      return { short: "", dirty: false, fingerprints: {} };
    }
    throw new Error(`Git status capture failed: ${detail}`);
  }
  const entries = parsePorcelainStatus(result.stdout ?? "");
  return {
    short: entries.map((entry) => entry.display).join("\n"),
    dirty: entries.length > 0,
    fingerprints: Object.fromEntries(entries.flatMap((entry) => entry.paths.map((file, index) => [
      file,
      {
        status: index === 0 ? entry.status : "D ",
        contentHash: hashWorkspacePath(cwd, file)
      }
    ])))
  };
}

interface PorcelainEntry {
  status: string;
  paths: string[];
  display: string;
}

function parsePorcelainStatus(output: string): PorcelainEntry[] {
  const tokens = output.split("\0").filter(Boolean);
  const entries: PorcelainEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4) continue;
    const status = token.slice(0, 2);
    const currentPath = token.slice(3);
    if (/[RC]/.test(status)) {
      const previousPath = tokens[index + 1];
      if (previousPath !== undefined) index += 1;
      const paths = previousPath ? [currentPath, previousPath] : [currentPath];
      entries.push({
        status,
        paths,
        display: previousPath ? `${status} ${previousPath} -> ${currentPath}` : `${status} ${currentPath}`
      });
      continue;
    }
    entries.push({ status, paths: [currentPath], display: `${status} ${currentPath}` });
  }
  return entries;
}

function hashWorkspacePath(cwd: string, file: string): string {
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "outside-workspace";
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      return crypto.createHash("sha256").update(`symlink:${fs.readlinkSync(absolute)}`).digest("hex");
    }
    if (!stat.isFile()) return stat.isDirectory() ? "directory" : "special";
    return crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
  } catch (error) {
    return isMissingPathError(error) ? "missing" : "unreadable";
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
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

export async function captureGitDiff(
  cwd: string,
  base = "HEAD",
  options: GitCaptureOptions = {}
): Promise<GitDiffSnapshot> {
  const validated = await execa(
    "git",
    gitArgs(cwd, ["rev-parse", "--verify", base]),
    gitCommandOptions(cwd, options, false)
  );
  if (validated.exitCode !== 0) {
    const detail = validated.stderr || `exit ${validated.exitCode}`;
    if (isMissingGitRepositoryError(detail)) {
      return { changedFiles: [], diffStat: "", diff: "" };
    }
    throw new Error(`Git diff capture failed for base ${base}: ${detail}`);
  }
  try {
    const [names, stat, diff] = await Promise.all([
      execa("git", gitArgs(cwd, ["diff", "--name-only", base]), gitCommandOptions(cwd, options)),
      execa("git", gitArgs(cwd, ["diff", "--stat", base]), gitCommandOptions(cwd, options)),
      execa("git", gitArgs(cwd, ["diff", base]), gitCommandOptions(cwd, options))
    ]);
    return {
      changedFiles: parseChangedFiles(names.stdout),
      diffStat: stat.stdout,
      diff: diff.stdout
    };
  } catch (error) {
    throw new Error(
      `Git diff capture failed for base ${base}: ${errorMessage(error)}`,
      { cause: error }
    );
  }
}

export async function captureGitHead(
  cwd: string,
  options: GitCaptureOptions = {}
): Promise<GitHeadSnapshot> {
  const oid = await execa(
    "git",
    gitArgs(cwd, ["rev-parse", "--verify", "HEAD"]),
    gitCommandOptions(cwd, options, false)
  );
  if (oid.exitCode !== 0) {
    const detail = oid.stderr || oid.stdout || `exit ${oid.exitCode}`;
    // Fresh `git init` / IntelliJ empty projects: branch exists, but HEAD has no commit yet.
    // Also tolerate missing/invalid `.git` placeholders so jobs can bootstrap a real repo.
    if (isUnbornHeadError(detail) || isMissingGitRepositoryError(detail)) {
      return { oid: "", short: "", subject: "" };
    }
    throw new Error(`Git HEAD capture failed: ${detail}`);
  }
  const summary = await execa(
    "git",
    gitArgs(cwd, ["log", "-1", "--format=%h %s"]),
    gitCommandOptions(cwd, options)
  );
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
  after: GitHeadSnapshot | undefined,
  options: GitCaptureOptions = {}
): Promise<GitCommitChangeSnapshot> {
  if (!before || !after || before.oid === after.oid) {
    return { commits: [], changedFiles: [] };
  }
  const [commits, files] = await Promise.all([
    execa(
      "git",
      gitArgs(cwd, ["log", "--oneline", "--reverse", `${before.oid}..${after.oid}`]),
      gitCommandOptions(cwd, options)
    ),
    execa(
      "git",
      gitArgs(cwd, ["diff", "--name-only", before.oid, after.oid]),
      gitCommandOptions(cwd, options)
    )
  ]);
  return {
    commits: parseChangedFiles(commits.stdout),
    changedFiles: parseChangedFiles(files.stdout)
  };
}

function gitCommandOptions(cwd: string, options: GitCaptureOptions, reject = true) {
  return {
    cwd,
    ...(reject ? {} : { reject: false as const }),
    ...(options.signal ? { cancelSignal: options.signal } : {})
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

function isUnbornHeadError(detail: string): boolean {
  return /Needed a single revision/i.test(detail)
    || /does not have any commits yet/i.test(detail)
    || /unknown revision or path not in the working tree/i.test(detail);
}

function isMissingGitRepositoryError(detail: string): boolean {
  return /not a git repository/i.test(detail);
}
