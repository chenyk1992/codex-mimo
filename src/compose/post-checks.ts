import type { GitHeadSnapshot, GitStatusSnapshot } from "../git/diff.js";

export function statusDeltaFiles(before: GitStatusSnapshot, after: GitStatusSnapshot): string[] {
  if (before.fingerprints && after.fingerprints) {
    return changedFingerprintFiles(before, after);
  }
  const beforeFiles = parseGitStatusFiles(before.short);
  const afterFiles = parseGitStatusFiles(after.short);
  return [...afterFiles].filter((file) => !beforeFiles.has(file));
}

export function detectReadOnlyViolationFiles(
  writesAllowed: boolean,
  changedFiles: string[],
  gitStatusBefore?: GitStatusSnapshot,
  gitStatusAfter?: GitStatusSnapshot
): string[] {
  if (writesAllowed) return [];
  if (!gitStatusBefore || !gitStatusAfter) return changedFiles;
  return statusDeltaFiles(gitStatusBefore, gitStatusAfter);
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
  return statusDeltaFiles(before, after);
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

function changedFingerprintFiles(before: GitStatusSnapshot, after: GitStatusSnapshot): string[] {
  const files = new Set([
    ...Object.keys(before.fingerprints),
    ...Object.keys(after.fingerprints)
  ]);
  return [...files].filter((file) => {
    const beforeFingerprint = before.fingerprints[file];
    const afterFingerprint = after.fingerprints[file];
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
