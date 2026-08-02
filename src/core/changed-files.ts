import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { changedFingerprintFiles, mergeChangedFiles } from "../compose/post-checks.js";
import type {
  GitCommitChangeSnapshot,
  GitDiffSnapshot,
  GitStatusSnapshot
} from "../git/diff.js";
import { isPathWithinAllowedScope, normalizeRepositoryPath } from "./path-scope.js";
import { isRuntimeArtifactPath } from "./runtime-paths.js";

const MAX_MANIFEST_FILES = 5_000;

export type ChangeDetectionStatus = "complete" | "partial" | "unavailable";

export interface WorkspaceManifest {
  fingerprints: Record<string, string>;
  complete: boolean;
}

export interface ChangeDetectionResult {
  files: string[];
  /** Verified outputs declared by acceptance.artifactPaths, kept separate from source changes. */
  artifactFiles: string[];
  candidates: string[];
  status: ChangeDetectionStatus;
  sources: Array<"git_fingerprint" | "git_diff" | "git_commit" | "scope_manifest">;
  reason?: string;
}

export function captureScopedWorkspaceManifest(
  cwd: string,
  allowedPaths: string[] | undefined
): WorkspaceManifest | undefined {
  if (!allowedPaths?.length) return undefined;
  const root = path.resolve(cwd);
  const fingerprints: Record<string, string> = {};
  let complete = true;

  for (const pattern of allowedPaths) {
    const normalized = normalizeRepositoryPath(pattern).replace(/\/\*\*$/, "").replace(/\/+$/, "");
    const absolute = path.resolve(root, normalized);
    const relative = normalizeRelative(root, absolute);
    if (relative === undefined || isRuntimeArtifactPath(relative)) {
      complete = false;
      continue;
    }
    walkManifestRoot(root, absolute, fingerprints, () => {
      complete = false;
    });
    if (Object.keys(fingerprints).length >= MAX_MANIFEST_FILES) {
      complete = false;
      break;
    }
  }
  return { fingerprints, complete };
}

export function detectChangedFiles(input: {
  cwd: string;
  gitStatusBefore?: GitStatusSnapshot;
  gitStatusAfter?: GitStatusSnapshot;
  diff?: GitDiffSnapshot;
  commitChanges?: GitCommitChangeSnapshot;
  manifestBefore?: WorkspaceManifest;
  manifestAfter?: WorkspaceManifest;
  toolUsePaths?: string[];
  artifactPaths?: string[];
}): ChangeDetectionResult {
  const sources: ChangeDetectionResult["sources"] = [];
  const verified: string[][] = [];
  const gitAvailable = input.gitStatusBefore?.repositoryAvailable !== false &&
    input.gitStatusAfter?.repositoryAvailable !== false &&
    input.gitStatusBefore !== undefined &&
    input.gitStatusAfter !== undefined;

  if (gitAvailable) {
    verified.push(changedFingerprintFiles(input.gitStatusBefore!, input.gitStatusAfter!));
    sources.push("git_fingerprint");
  }
  // `git diff HEAD` includes tracked changes that may pre-date this job.
  // A file already dirty in the before snapshot is therefore accepted only
  // through the fingerprint delta above. Diff-only files that were clean at
  // the baseline remain useful supplemental evidence (and support degraded
  // status providers that omit a later fingerprint).
  if (input.diff?.changedFiles.length) {
    const diffFiles = gitAvailable
      ? input.diff.changedFiles.filter(
          (file) => !(file in input.gitStatusBefore!.fingerprints)
        )
      : input.diff.changedFiles;
    if (diffFiles.length > 0) {
      verified.push(diffFiles);
      sources.push("git_diff");
    }
  }
  if (input.commitChanges?.changedFiles.length) {
    verified.push(input.commitChanges.changedFiles);
    sources.push("git_commit");
  }

  const manifestUsable = input.manifestBefore !== undefined && input.manifestAfter !== undefined;
  if (manifestUsable) {
    verified.push(changedManifestFiles(input.manifestBefore!, input.manifestAfter!));
    sources.push("scope_manifest");
  }

  const detectedFiles = excludeRuntime(mergeChangedFiles(...verified));
  const artifactFiles = input.artifactPaths?.length
    ? detectedFiles.filter((file) => isPathWithinAllowedScope(file, input.artifactPaths!))
    : [];
  const files = detectedFiles.filter((file) => !artifactFiles.includes(file));
  const candidates = excludeRuntime(
    normalizeCandidatePaths(input.cwd, input.toolUsePaths ?? [])
      .filter((file) => !detectedFiles.includes(file))
  );
  const manifestComplete = Boolean(
    input.manifestBefore?.complete && input.manifestAfter?.complete
  );
  const status: ChangeDetectionStatus = gitAvailable && candidates.length === 0
    ? "complete"
    : manifestComplete && candidates.every((file) =>
        file in input.manifestBefore!.fingerprints || file in input.manifestAfter!.fingerprints)
      ? "complete"
      : files.length > 0 || candidates.length > 0 || sources.length > 0
        ? "partial"
        : "unavailable";

  return {
    files,
    artifactFiles,
    candidates,
    status,
    sources: [...new Set(sources)],
    ...(status === "complete"
      ? {}
      : {
          reason: status === "unavailable"
            ? "No reliable Git or scoped filesystem baseline was available."
            : "Some write candidates could not be verified against a complete baseline."
        })
  };
}

export function fingerprintWorkspaceFiles(cwd: string, files: string[]): string {
  const root = path.resolve(cwd);
  const lines = [...new Set(files.map((file) => normalizeRepositoryPath(file)))]
    .sort()
    .map((file) => {
      const absolute = path.resolve(root, file);
      const relative = normalizeRelative(root, absolute);
      return `${file}:${relative === undefined ? "outside-workspace" : hashPath(absolute)}`;
    });
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

function changedManifestFiles(
  before: WorkspaceManifest,
  after: WorkspaceManifest
): string[] {
  const files = new Set([
    ...Object.keys(before.fingerprints),
    ...Object.keys(after.fingerprints)
  ]);
  return [...files].filter((file) => before.fingerprints[file] !== after.fingerprints[file]);
}

function walkManifestRoot(
  workspaceRoot: string,
  absolute: string,
  fingerprints: Record<string, string>,
  markIncomplete: () => void
): void {
  if (Object.keys(fingerprints).length >= MAX_MANIFEST_FILES) {
    markIncomplete();
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (isMissingPathError(error)) return;
    markIncomplete();
    return;
  }
  const relative = normalizeRelative(workspaceRoot, absolute);
  if (relative === undefined || isRuntimeArtifactPath(relative)) return;
  if (stat.isSymbolicLink() || stat.isFile()) {
    fingerprints[relative] = hashPath(absolute);
    return;
  }
  if (!stat.isDirectory()) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch {
    markIncomplete();
    return;
  }
  for (const entry of entries) {
    walkManifestRoot(workspaceRoot, path.join(absolute, entry.name), fingerprints, markIncomplete);
    if (Object.keys(fingerprints).length >= MAX_MANIFEST_FILES) {
      markIncomplete();
      return;
    }
  }
}

function hashPath(absolute: string): string {
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

function normalizeCandidatePaths(cwd: string, candidates: string[]): string[] {
  const root = path.resolve(cwd);
  return [...new Set(candidates.flatMap((candidate) => {
    const absolute = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(root, candidate);
    const relative = normalizeRelative(root, absolute);
    return relative === undefined ? [] : [relative];
  }))].sort();
}

function normalizeRelative(root: string, absolute: string): string | undefined {
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return normalizeRepositoryPath(relative || ".");
}

function excludeRuntime(files: string[]): string[] {
  return files.filter((file) => !isRuntimeArtifactPath(file));
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}
