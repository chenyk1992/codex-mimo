import { execa } from "execa";
import path from "node:path";

import type {
  GitCommitChangeSnapshot,
  GitHeadSnapshot,
  GitStatusSnapshot
} from "../git/diff.js";
import { findOutOfScopePaths, isPathWithinAllowedScope } from "../core/path-scope.js";
import { extractFinalText, parseMimoJsonLines } from "./events.js";
import { detectUnacceptedTask } from "../core/job-outcome.js";
import type { AcceptanceStageResult } from "./acceptance.js";

export { isPathWithinAllowedScope } from "../core/path-scope.js";

export interface DiffAcceptanceInput {
  cwd: string;
  changedFiles: string[];
  allowedPaths?: string[];
  gitHeadBefore?: GitHeadSnapshot;
  gitHeadAfter?: GitHeadSnapshot;
  commitChanges?: GitCommitChangeSnapshot;
  diffText?: string;
  signal?: AbortSignal;
  forbidCommits?: boolean;
  runGitDiffCheck?: (
    cwd: string,
    signal?: AbortSignal
  ) => Promise<{ passed: boolean; reason?: string }>;
}

const ACCIDENTAL_ARTIFACT_PREFIXES = ["node_modules/", ".next/", "dist/"];

function gitArgs(cwd: string, args: string[]): string[] {
  const absolute = path.isAbsolute(cwd) || /^[a-zA-Z]:[\\/]/.test(cwd)
    ? cwd
    : path.resolve(cwd);
  return ["-c", `safe.directory=${absolute.replace(/\\/g, "/")}`, ...args];
}

async function defaultRunGitDiffCheck(
  cwd: string,
  signal?: AbortSignal
): Promise<{ passed: boolean; reason?: string }> {
  const result = await execa("git", gitArgs(cwd, ["diff", "--check"]), {
    cwd,
    reject: false,
    ...(signal ? { cancelSignal: signal } : {})
  });
  if (result.exitCode === 0) {
    return { passed: true };
  }
  return {
    passed: false,
    reason: result.stderr || result.stdout || `exit ${result.exitCode ?? "unknown"}`
  };
}

export function findOutOfScopeChangedFiles(changedFiles: string[], allowedPaths: string[]): string[] {
  if (allowedPaths.length === 0) {
    return [];
  }
  return findOutOfScopePaths(changedFiles, allowedPaths);
}

export function findAccidentalArtifactFiles(
  changedFiles: string[],
  allowedPaths?: string[]
): string[] {
  return changedFiles.filter((file) => {
    const normalized = file.replace(/\\/g, "/");
    const isArtifact = ACCIDENTAL_ARTIFACT_PREFIXES.some(
      (prefix) => normalized.includes(prefix) || normalized.startsWith(prefix.replace(/\/$/, ""))
    );
    if (!isArtifact) {
      return false;
    }
    if (!allowedPaths || allowedPaths.length === 0) {
      return true;
    }
    return !isPathWithinAllowedScope(file, allowedPaths);
  });
}

export function findConflictMarkerFiles(diffText: string, changedFiles: string[]): string[] {
  const markerPattern = /<<<<<<<|>>>>>>>/;
  if (!markerPattern.test(diffText)) {
    return [];
  }

  const files: string[] = [];
  for (const section of diffText.split(/^diff --git /m)) {
    if (!markerPattern.test(section)) {
      continue;
    }
    const match = section.match(/^a\/(.+?) b\//);
    if (match) {
      files.push(match[1]);
    }
  }

  if (files.length > 0) {
    return [...new Set(files)];
  }
  return changedFiles.length > 0 ? [changedFiles[0]] : ["unknown"];
}

export async function runDeterministicDiffAcceptance(
  input: DiffAcceptanceInput
): Promise<AcceptanceStageResult> {
  const forbidCommits = input.forbidCommits !== false;
  const runCheck = input.runGitDiffCheck ?? defaultRunGitDiffCheck;

  const checkResult = await runCheck(input.cwd, input.signal);
  if (!checkResult.passed) {
    return {
      stage: "diff_check",
      outcome: "failed",
      command: "git diff --check",
      reason: checkResult.reason,
      suggestion:
        "Fix whitespace or conflict-marker errors reported by git diff --check, then rerun the diff check."
    };
  }

  if (input.allowedPaths && input.allowedPaths.length > 0) {
    const outOfScope = findOutOfScopeChangedFiles(input.changedFiles, input.allowedPaths);
    if (outOfScope.length > 0) {
      return {
        stage: "diff_check",
        outcome: "failed",
        reason: `Out-of-scope changes: ${outOfScope.join(", ")}`,
        suggestion: `Remove out-of-scope change ${outOfScope[0]}, then rerun the diff check.`
      };
    }
  }

  if (forbidCommits && input.commitChanges && input.commitChanges.commits.length > 0) {
    return {
      stage: "diff_check",
      outcome: "failed",
      reason: `Unexpected commits: ${input.commitChanges.commits.join(", ")}`,
      suggestion: "Revert unexpected commits, then rerun the diff check."
    };
  }

  if (input.diffText) {
    const conflictFiles = findConflictMarkerFiles(input.diffText, input.changedFiles);
    if (conflictFiles.length > 0) {
      return {
        stage: "diff_check",
        outcome: "failed",
        reason: `Conflict markers in ${conflictFiles.join(", ")}`,
        suggestion: `Resolve conflict markers in ${conflictFiles[0]}, then rerun the diff check.`
      };
    }
  }

  const artifacts = findAccidentalArtifactFiles(input.changedFiles, input.allowedPaths);
  if (artifacts.length > 0) {
    return {
      stage: "diff_check",
      outcome: "failed",
      reason: `Accidental generated artifacts: ${artifacts.join(", ")}`,
      suggestion: `Remove accidental artifact ${artifacts[0]}, then rerun the diff check.`
    };
  }

  return { stage: "diff_check", outcome: "passed" };
}

export function detectSemanticFailure(eventsStdout: string): string | undefined {
  return detectUnacceptedTask(extractFinalText(parseMimoJsonLines(eventsStdout)));
}

export function detectDirectSemanticFailure(summary: string | undefined): string | null {
  return detectUnacceptedTask(summary) ?? null;
}

export function detectReadOnlyViolationFiles(
  writesAllowed: boolean,
  changedFiles: string[],
  gitStatusBefore?: GitStatusSnapshot,
  gitStatusAfter?: GitStatusSnapshot
): string[] {
  if (writesAllowed) return [];
  if (!gitStatusBefore || !gitStatusAfter) return changedFiles;

  if (gitStatusBefore.fingerprints && gitStatusAfter.fingerprints) {
    return changedFingerprintFiles(gitStatusBefore, gitStatusAfter);
  }

  const beforeFiles = parseGitStatusFiles(gitStatusBefore.short);
  const afterFiles = parseGitStatusFiles(gitStatusAfter.short);
  return [...afterFiles].filter((file) => !beforeFiles.has(file));
}

export function buildReadOnlyReportDiff(
  diff: { changedFiles: string[]; diffStat: string; diff: string },
  readOnlyViolationFiles: string[]
): { changedFiles: string[]; diffStat: string; diff: string } {
  if (readOnlyViolationFiles.length === 0) {
    return { changedFiles: [], diffStat: "", diff: "" };
  }
  return { ...diff, changedFiles: readOnlyViolationFiles };
}

export function detectNewFilesFromStatus(before: GitStatusSnapshot, after: GitStatusSnapshot): string[] {
  if (before.fingerprints && after.fingerprints) {
    return changedFingerprintFiles(before, after);
  }
  const beforeFiles = parseGitStatusFiles(before.short);
  const afterFiles = parseGitStatusFiles(after.short);
  return [...afterFiles].filter((file) => !beforeFiles.has(file));
}

export function parseGitStatusFiles(status: string): Set<string> {
  return new Set(
    status
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => (line.length > 3 ? line.slice(3).trim() : line.trim()))
      .filter(Boolean)
  );
}

export function changedFingerprintFiles(before: GitStatusSnapshot, after: GitStatusSnapshot): string[] {
  const beforeFingerprints = before.fingerprints ?? {};
  const afterFingerprints = after.fingerprints ?? {};
  const files = new Set([
    ...Object.keys(beforeFingerprints),
    ...Object.keys(afterFingerprints)
  ]);
  return [...files].filter((file) => {
    const beforeFingerprint = beforeFingerprints[file];
    const afterFingerprint = afterFingerprints[file];
    return beforeFingerprint?.status !== afterFingerprint?.status
      || beforeFingerprint?.contentHash !== afterFingerprint?.contentHash;
  });
}

export function gitHeadChanged(before?: GitHeadSnapshot, after?: GitHeadSnapshot): boolean {
  return Boolean(before && after && before.oid !== after.oid);
}

export function mergeChangedFiles(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

export function readOnlyViolationError(
  workflowName: string,
  files: string[],
  before?: GitHeadSnapshot,
  after?: GitHeadSnapshot
): string {
  const details: string[] = [];
  if (gitHeadChanged(before, after)) {
    details.push(
      `Read-only workflow ${workflowName} changed HEAD from ${before?.short || "unknown"} to ${after?.short || "unknown"}.`
    );
  }
  if (files.length > 0) {
    details.push(`Read-only workflow ${workflowName} modified files: ${files.join(", ")}`);
  }
  return details.join(" ");
}
