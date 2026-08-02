import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureWorkspaceManifest,
  isPathContainedBy,
  isSafeWorkspaceSymlink,
  materializeWorkspaceManifest,
  type CaptureWorkspaceManifestOptions,
  type WorkspaceManifest
} from "../core/execution-workspace.js";

const OWNER_METADATA_NAME = "codex-mimo-execution-workspace.json";
const OWNER_METADATA_VERSION = 1;
const WORKSPACE_CHANGED_DURING_PREPARATION = "Workspace changed during preparation.";

export interface PrepareGitExecutionWorkspaceOptions extends CaptureWorkspaceManifestOptions {
  /**
   * Invoked immediately before the final control-workspace stability check.
   * This is primarily useful for deterministic integration tests.
   */
  onBeforeBaselineVerification?: () => void;
}

export interface PreparedGitExecutionWorkspace {
  controlRoot: string;
  executionRoot: string;
  baseline: WorkspaceManifest;
  ownerMetadataPath: string;
  ownerToken: string;
}

/** Private durable handle. Never return ownerToken through public job rendering. */
export interface PersistentWorktreeLease extends PreparedGitExecutionWorkspace {
  mode: "persistent";
  jobId: string;
  branch: string;
  createdAt: string;
}

export interface DisposeGitExecutionWorkspaceOptions {
  /** Leave a validated worktree intact for diagnostics. */
  retain?: boolean;
}

interface ExecutionWorkspaceOwnerMetadata {
  version: number;
  controlRoot: string;
  executionRoot: string;
  ownerToken: string;
  mode?: "persistent";
  jobId?: string;
  branch?: string;
  createdAt?: string;
}

export function persistentWorktreePath(
  controlRoot: string,
  jobId: string,
  base = process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(jobId)) {
    throw new Error("Persistent worktree job id is invalid.");
  }
  const resolvedControlRoot = path.resolve(controlRoot);
  const repositoryIdentity = process.platform === "win32"
    ? resolvedControlRoot.toLowerCase()
    : resolvedControlRoot;
  const repoHash = crypto.createHash("sha256").update(repositoryIdentity).digest("hex").slice(0, 16);
  return path.join(base, "codex-mimo", "worktrees", repoHash, jobId);
}

/** Creates a bridge-owned named branch and retains it for resume/inspection. */
export function preparePersistentGitWorktree(
  controlRoot: string,
  jobId: string,
  options: PrepareGitExecutionWorkspaceOptions & { base?: string } = {}
): PersistentWorktreeLease {
  const executionRoot = persistentWorktreePath(controlRoot, jobId, options.base);
  const branch = `codex-mimo/worktree/${jobId}`;
  const resolvedControlRoot = validateControlWorktree(controlRoot);
  const resolvedExecutionRoot = validateNewExecutionRoot(resolvedControlRoot, executionRoot);
  const baseline = captureWorkspaceManifest(resolvedControlRoot, options);
  const initialHead = runGit(resolvedControlRoot, ["rev-parse", "HEAD"]).trim();
  const stagedPatch = runGit(resolvedControlRoot, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff"]);
  for (const entry of baseline.entries) {
    if (entry.kind === "symlink" && !isSafeWorkspaceSymlink(resolvedControlRoot, entry.path, entry.target)) {
      throw new Error(`Workspace symlink escapes source root: ${entry.path}`);
    }
  }
  const ownerToken = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  let added = false;
  try {
    fs.mkdirSync(path.dirname(resolvedExecutionRoot), { recursive: true });
    runGit(resolvedControlRoot, ["worktree", "add", "-b", branch, resolvedExecutionRoot, "HEAD"]);
    added = true;
    clearExecutionWorktree(resolvedExecutionRoot);
    materializeWorkspaceManifest(resolvedControlRoot, resolvedExecutionRoot, baseline);
    if (stagedPatch) runGit(resolvedExecutionRoot, ["apply", "--cached", "--whitespace=nowarn"], stagedPatch);
    options.onBeforeBaselineVerification?.();
    assertControlBaselineUnchanged(resolvedControlRoot, baseline, stagedPatch, options);
    const ownerMetadataPath = path.join(resolveGitDirectory(resolvedExecutionRoot), OWNER_METADATA_NAME);
    fs.writeFileSync(ownerMetadataPath, JSON.stringify({ version: OWNER_METADATA_VERSION, controlRoot: resolvedControlRoot, executionRoot: resolvedExecutionRoot, ownerToken, mode: "persistent", jobId, branch, createdAt } satisfies ExecutionWorkspaceOwnerMetadata));
    return { controlRoot: resolvedControlRoot, executionRoot: resolvedExecutionRoot, baseline, ownerMetadataPath, ownerToken, mode: "persistent", jobId, branch, createdAt };
  } catch (error) {
    if (added) {
      try {
        removeVerifiedWorktree(resolvedControlRoot, resolvedExecutionRoot);
        // We created this name with -b. Delete it only when it still points to
        // the exact initial control HEAD; never touch a pre-existing/repointed ref.
        if (runGit(resolvedControlRoot, ["rev-parse", branch]).trim() === initialHead) {
          runGit(resolvedControlRoot, ["branch", "-D", branch]);
        }
      } catch { /* fail closed; preserve uncertain diagnostics */ }
    }
    throw error;
  }
}

/** Validates an on-disk lease before reuse; any mismatch is untrusted. */
export function reopenPersistentGitWorktree(lease: Omit<PersistentWorktreeLease, "baseline">): PersistentWorktreeLease {
  const controlRoot = validateControlWorktree(lease.controlRoot);
  const executionRoot = validateExistingExecutionRoot(controlRoot, lease.executionRoot);
  const metadataPath = path.join(resolveGitDirectory(executionRoot), OWNER_METADATA_NAME);
  const metadata = readOwnerMetadata(metadataPath);
  const branch = runGit(executionRoot, ["branch", "--show-current"]).trim();
  const registered = runGit(controlRoot, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/).some((line) => line.startsWith("worktree ") && pathsEqual(line.slice("worktree ".length), executionRoot));
  const controlCommon = resolveGitPath(controlRoot, runGit(controlRoot, ["rev-parse", "--git-common-dir"]).trim());
  const executionCommon = resolveGitPath(executionRoot, runGit(executionRoot, ["rev-parse", "--git-common-dir"]).trim());
  if (metadata.version !== OWNER_METADATA_VERSION || metadata.mode !== "persistent" ||
      metadata.jobId !== lease.jobId || metadata.branch !== lease.branch || metadata.createdAt !== lease.createdAt ||
      metadata.ownerToken !== lease.ownerToken || !pathsEqual(metadata.controlRoot, controlRoot) ||
      !pathsEqual(metadata.executionRoot, executionRoot) || branch !== lease.branch || !pathsEqual(metadataPath, lease.ownerMetadataPath) ||
      !registered || !pathsEqual(controlCommon, executionCommon)) {
    throw new Error("Persistent worktree lease is missing or does not match its owner metadata.");
  }
  return { ...lease, controlRoot, executionRoot, baseline: captureWorkspaceManifest(executionRoot) };
}

/**
 * Builds a detached Git worktree, then overlays the control checkout's full
 * editable baseline. The resulting worktree has a normal Git index at HEAD
 * while its files include dirty, staged, untracked and ignored control files.
 */
export function prepareGitExecutionWorkspace(
  controlRoot: string,
  executionRoot: string,
  options: PrepareGitExecutionWorkspaceOptions = {}
): PreparedGitExecutionWorkspace {
  const resolvedControlRoot = validateControlWorktree(controlRoot);
  const resolvedExecutionRoot = validateNewExecutionRoot(resolvedControlRoot, executionRoot);
  const baseline = captureWorkspaceManifest(resolvedControlRoot, options);
  const stagedPatch = runGit(resolvedControlRoot, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff"]);
  for (const entry of baseline.entries) {
    if (entry.kind === "symlink" && !isSafeWorkspaceSymlink(resolvedControlRoot, entry.path, entry.target)) {
      throw new Error(`Workspace symlink escapes source root: ${entry.path}`);
    }
  }
  const ownerToken = crypto.randomUUID();
  let worktreeAdded = false;

  try {
    runGit(resolvedControlRoot, ["worktree", "add", "--detach", resolvedExecutionRoot, "HEAD"]);
    worktreeAdded = true;
    clearExecutionWorktree(resolvedExecutionRoot);
    materializeWorkspaceManifest(resolvedControlRoot, resolvedExecutionRoot, baseline);
    if (stagedPatch) {
      runGit(resolvedExecutionRoot, ["apply", "--cached", "--whitespace=nowarn"], stagedPatch);
    }
    options.onBeforeBaselineVerification?.();
    assertControlBaselineUnchanged(resolvedControlRoot, baseline, stagedPatch, options);

    const ownerMetadataPath = path.join(resolveGitDirectory(resolvedExecutionRoot), OWNER_METADATA_NAME);
    fs.writeFileSync(ownerMetadataPath, JSON.stringify({
      version: OWNER_METADATA_VERSION,
      controlRoot: resolvedControlRoot,
      executionRoot: resolvedExecutionRoot,
      ownerToken
    } satisfies ExecutionWorkspaceOwnerMetadata));

    return {
      controlRoot: resolvedControlRoot,
      executionRoot: resolvedExecutionRoot,
      baseline,
      ownerMetadataPath,
      ownerToken
    };
  } catch (error) {
    if (worktreeAdded) {
      try {
        removeVerifiedWorktree(resolvedControlRoot, resolvedExecutionRoot);
      } catch {
        // Preserve a failed worktree rather than recursively deleting an
        // unverified path. The original preparation failure remains primary.
      }
    }
    throw error;
  }
}

function assertControlBaselineUnchanged(
  controlRoot: string,
  baseline: WorkspaceManifest,
  stagedPatch: string,
  options: CaptureWorkspaceManifestOptions
): void {
  try {
    const currentBaseline = captureWorkspaceManifest(controlRoot, options);
    const currentStagedPatch = runGit(controlRoot, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff"]);
    if (JSON.stringify(currentBaseline.entries) !== JSON.stringify(baseline.entries) || currentStagedPatch !== stagedPatch) {
      throw new Error(WORKSPACE_CHANGED_DURING_PREPARATION);
    }
  } catch (error) {
    if (error instanceof Error && error.message === WORKSPACE_CHANGED_DURING_PREPARATION) throw error;
    throw new Error(WORKSPACE_CHANGED_DURING_PREPARATION);
  }
}

/**
 * Removes only a worktree created by prepareGitExecutionWorkspace. Both its
 * Git registration and private owner metadata must match the supplied handle.
 */
export function disposeGitExecutionWorkspace(
  workspace: PreparedGitExecutionWorkspace,
  options: DisposeGitExecutionWorkspaceOptions = {}
): void {
  if (options.retain) return;

  const controlRoot = validateControlWorktree(workspace.controlRoot);
  const executionRoot = validateExistingExecutionRoot(controlRoot, workspace.executionRoot);
  const expectedMetadataPath = path.join(resolveGitDirectory(executionRoot), OWNER_METADATA_NAME);
  if (!pathsEqual(expectedMetadataPath, workspace.ownerMetadataPath)) {
    throw new Error("Execution workspace owner metadata is not in the worktree Git directory");
  }
  const metadata = readOwnerMetadata(expectedMetadataPath);
  if (
    metadata.version !== OWNER_METADATA_VERSION
    || !pathsEqual(metadata.controlRoot, controlRoot)
    || !pathsEqual(metadata.executionRoot, executionRoot)
    || metadata.ownerToken !== workspace.ownerToken
  ) {
    throw new Error("Execution workspace owner metadata does not match the supplied workspace");
  }

  removeVerifiedWorktree(controlRoot, executionRoot);
}

function validateControlWorktree(controlRoot: string): string {
  const resolvedControlRoot = path.resolve(controlRoot);
  const stat = fs.lstatSync(resolvedControlRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Control workspace must be a real directory: ${resolvedControlRoot}`);
  }
  const topLevel = runGit(resolvedControlRoot, ["rev-parse", "--show-toplevel"]).trim();
  if (!pathsEqual(path.resolve(topLevel), resolvedControlRoot)) {
    throw new Error(`Control workspace must be the Git worktree root: ${resolvedControlRoot}`);
  }
  runGit(resolvedControlRoot, ["rev-parse", "--verify", "HEAD"]);
  return resolvedControlRoot;
}

function validateNewExecutionRoot(controlRoot: string, executionRoot: string): string {
  const resolvedExecutionRoot = path.resolve(executionRoot);
  validateExecutionRootRelation(controlRoot, resolvedExecutionRoot);
  if (fs.existsSync(resolvedExecutionRoot)) {
    throw new Error(`Execution worktree already exists: ${resolvedExecutionRoot}`);
  }
  return resolvedExecutionRoot;
}

function validateExistingExecutionRoot(controlRoot: string, executionRoot: string): string {
  const resolvedExecutionRoot = path.resolve(executionRoot);
  validateExecutionRootRelation(controlRoot, resolvedExecutionRoot);
  const stat = fs.lstatSync(resolvedExecutionRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Execution worktree must be a real directory: ${resolvedExecutionRoot}`);
  }
  return resolvedExecutionRoot;
}

function validateExecutionRootRelation(controlRoot: string, executionRoot: string): void {
  if (
    pathsEqual(controlRoot, executionRoot)
    || isPathContainedBy(controlRoot, executionRoot)
    || isPathContainedBy(executionRoot, controlRoot)
    || pathsEqual(executionRoot, path.parse(executionRoot).root)
  ) {
    throw new Error("Execution worktree must be a distinct sibling or external directory");
  }
}

function clearExecutionWorktree(executionRoot: string): void {
  const stat = fs.lstatSync(executionRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Execution worktree must be a real directory: ${executionRoot}`);
  }
  for (const entry of fs.readdirSync(executionRoot)) {
    if (entry === ".git") continue;
    fs.rmSync(path.join(executionRoot, entry), { recursive: true, force: true });
  }
}

function readOwnerMetadata(ownerMetadataPath: string): ExecutionWorkspaceOwnerMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(ownerMetadataPath, "utf8"));
  } catch {
    throw new Error("Execution workspace owner metadata is missing or invalid");
  }
  if (
    typeof parsed !== "object" || parsed === null
    || typeof (parsed as Partial<ExecutionWorkspaceOwnerMetadata>).version !== "number"
    || typeof (parsed as Partial<ExecutionWorkspaceOwnerMetadata>).controlRoot !== "string"
    || typeof (parsed as Partial<ExecutionWorkspaceOwnerMetadata>).executionRoot !== "string"
    || typeof (parsed as Partial<ExecutionWorkspaceOwnerMetadata>).ownerToken !== "string"
  ) {
    throw new Error("Execution workspace owner metadata is invalid");
  }
  return parsed as ExecutionWorkspaceOwnerMetadata;
}

function removeVerifiedWorktree(controlRoot: string, executionRoot: string): void {
  const worktrees = runGit(controlRoot, ["worktree", "list", "--porcelain"]);
  const registered = worktrees
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)))
    .some((candidate) => pathsEqual(candidate, executionRoot));
  if (!registered) {
    throw new Error(`Execution worktree is not registered by control repository: ${executionRoot}`);
  }
  runGit(controlRoot, ["worktree", "remove", "--force", executionRoot]);
  runGit(controlRoot, ["worktree", "prune"]);
}

function resolveGitDirectory(cwd: string): string {
  return resolveGitPath(cwd, runGit(cwd, ["rev-parse", "--absolute-git-dir"]).trim());
}

function resolveGitPath(cwd: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
}

function runGit(cwd: string, args: string[], input?: string): string {
  try {
    return execFileSync("git", ["-c", `safe.directory=${safeDirectory(cwd)}`, ...args], {
      cwd,
      encoding: "utf8",
      ...(input === undefined ? {} : { input }),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
  } catch (error) {
    const detail = error instanceof Error && "stderr" in error
      ? String((error as NodeJS.ErrnoException & { stderr?: Buffer | string }).stderr ?? "").trim()
      : "";
    throw new Error(`Git command failed (${args.join(" ")}): ${detail || (error instanceof Error ? error.message : String(error))}`);
  }
}

function safeDirectory(cwd: string): string {
  return path.resolve(cwd).replace(/\\/g, "/");
}

function pathsEqual(first: string, second: string): boolean {
  return process.platform === "win32"
    ? path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase()
    : path.resolve(first) === path.resolve(second);
}
