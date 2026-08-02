import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type WorkspaceEntryKind = "directory" | "file" | "symlink";

export interface WorkspaceDirectoryEntry {
  kind: "directory";
  path: string;
}

export interface WorkspaceFileEntry {
  kind: "file";
  path: string;
  size: number;
  sha256: string;
}

export interface WorkspaceSymlinkEntry {
  kind: "symlink";
  path: string;
  target: string;
}

export type WorkspaceEntry = WorkspaceDirectoryEntry | WorkspaceFileEntry | WorkspaceSymlinkEntry;

export interface WorkspaceManifest {
  rootPath: string;
  entries: WorkspaceEntry[];
}

export interface CaptureWorkspaceManifestOptions {
  maxEntries?: number;
}

export interface PrepareExecutionWorkspaceInput extends CaptureWorkspaceManifestOptions {
  sourceRoot: string;
  executionRoot: string;
}

export interface PreparedExecutionWorkspace {
  sourceRoot: string;
  executionRoot: string;
  baseline: WorkspaceManifest;
  ownerMetadataPath: string;
  ownerToken: string;
}

const DEFAULT_MAX_ENTRIES = 100_000;
const EXCLUDED_DIRECTORY_NAMES = new Set([".git", ".codex-mimo"]);
const OWNER_METADATA_NAME = "execution-workspace.json";

/**
 * Captures a deterministic, non-following manifest of a workspace. Runtime and
 * git metadata are intentionally excluded because neither is part of a task's
 * editable source tree.
 */
export function captureWorkspaceManifest(
  root: string,
  options: CaptureWorkspaceManifestOptions = {}
): WorkspaceManifest {
  const rootPath = path.resolve(root);
  const rootStat = fs.lstatSync(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Workspace root must be a real directory: ${rootPath}`);
  }

  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("maxEntries must be a positive safe integer");
  }

  const entries: WorkspaceEntry[] = [];
  const visit = (absolutePath: string, relativePath: string): void => {
    const stat = fs.lstatSync(absolutePath);
    if (entries.length >= maxEntries) {
      throw new Error(`Workspace manifest exceeds maximum entry count (${maxEntries})`);
    }

    if (stat.isSymbolicLink()) {
      entries.push({
        kind: "symlink",
        path: toRepositoryPath(relativePath),
        target: fs.readlinkSync(absolutePath)
      });
      return;
    }

    if (stat.isDirectory()) {
      if (relativePath) {
        entries.push({ kind: "directory", path: toRepositoryPath(relativePath) });
      }
      for (const childName of fs.readdirSync(absolutePath).sort()) {
        if (EXCLUDED_DIRECTORY_NAMES.has(childName)) continue;
        visit(path.join(absolutePath, childName), path.join(relativePath, childName));
      }
      return;
    }

    if (!stat.isFile()) {
      throw new Error(`Unsupported workspace entry type: ${absolutePath}`);
    }

    entries.push({
      kind: "file",
      path: toRepositoryPath(relativePath),
      size: stat.size,
      sha256: sha256File(absolutePath)
    });
  };

  for (const childName of fs.readdirSync(rootPath).sort()) {
    if (EXCLUDED_DIRECTORY_NAMES.has(childName)) continue;
    visit(path.join(rootPath, childName), childName);
  }

  return { rootPath, entries };
}

/**
 * Creates a byte-for-byte isolated copy from a previously stable source tree.
 * It never follows links and rejects links which would escape the source root.
 */
export function prepareExecutionWorkspace(input: PrepareExecutionWorkspaceInput): PreparedExecutionWorkspace {
  const sourceRoot = path.resolve(input.sourceRoot);
  const executionRoot = path.resolve(input.executionRoot);
  if (pathsEqual(sourceRoot, executionRoot) || isPathContainedBy(sourceRoot, executionRoot)) {
    throw new Error("Execution workspace must not be the source workspace or one of its descendants");
  }
  if (fs.existsSync(executionRoot)) {
    throw new Error(`Execution workspace already exists: ${executionRoot}`);
  }

  const baseline = captureWorkspaceManifest(sourceRoot, input);
  for (const entry of baseline.entries) {
    if (entry.kind === "symlink" && !isSafeWorkspaceSymlink(sourceRoot, entry.path, entry.target)) {
      throw new Error(`Workspace symlink escapes source root: ${entry.path}`);
    }
  }

  const ownerToken = crypto.randomUUID();
  fs.mkdirSync(executionRoot, { recursive: true });
  try {
    materializeWorkspaceManifest(sourceRoot, executionRoot, baseline);
    const ownerMetadataPath = path.join(executionRoot, ".codex-mimo", OWNER_METADATA_NAME);
    fs.mkdirSync(path.dirname(ownerMetadataPath), { recursive: true });
    fs.writeFileSync(ownerMetadataPath, JSON.stringify({ sourceRoot, executionRoot, ownerToken }), "utf8");
    return { sourceRoot, executionRoot, baseline, ownerMetadataPath, ownerToken };
  } catch (error) {
    fs.rmSync(executionRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Removes only a copy created by prepareExecutionWorkspace and still owned by its handle. */
export function disposeExecutionWorkspace(workspace: PreparedExecutionWorkspace, options: { retain?: boolean } = {}): void {
  if (options.retain) return;
  const sourceRoot = path.resolve(workspace.sourceRoot);
  const executionRoot = path.resolve(workspace.executionRoot);
  if (pathsEqual(sourceRoot, executionRoot) || isPathContainedBy(sourceRoot, executionRoot)) {
    throw new Error("Execution workspace is not safely separate from the source workspace");
  }
  const metadataPath = path.join(executionRoot, ".codex-mimo", OWNER_METADATA_NAME);
  if (!pathsEqual(metadataPath, workspace.ownerMetadataPath)) {
    throw new Error("Execution workspace owner metadata path does not match");
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch {
    throw new Error("Execution workspace owner metadata is missing or invalid");
  }
  if (
    typeof metadata !== "object" || metadata === null ||
    (metadata as { sourceRoot?: unknown }).sourceRoot !== sourceRoot ||
    (metadata as { executionRoot?: unknown }).executionRoot !== executionRoot ||
    (metadata as { ownerToken?: unknown }).ownerToken !== workspace.ownerToken
  ) {
    throw new Error("Execution workspace owner metadata does not match");
  }
  fs.rmSync(executionRoot, { recursive: true, force: true });
}

/**
 * Materializes a captured workspace baseline into an existing, real directory.
 * The destination is deliberately separate from capture so a Git worktree can
 * retain its `.git` administrative entry while all editable files are copied.
 */
export function materializeWorkspaceManifest(
  sourceRoot: string,
  destinationRoot: string,
  baseline: WorkspaceManifest
): void {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const resolvedDestinationRoot = path.resolve(destinationRoot);
  const destinationStat = fs.lstatSync(resolvedDestinationRoot);
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
    throw new Error(`Execution workspace must be a real directory: ${resolvedDestinationRoot}`);
  }

  for (const entry of baseline.entries) {
    const destination = resolveWorkspaceEntryPath(resolvedDestinationRoot, entry.path);
    if (entry.kind === "directory") {
      fs.mkdirSync(destination, { recursive: true });
    } else if (entry.kind === "file") {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(resolveWorkspaceEntryPath(resolvedSourceRoot, entry.path), destination);
      if (sha256File(destination) !== entry.sha256) {
        throw new Error(`Workspace file changed while preparing execution copy: ${entry.path}`);
      }
    } else {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const rewrittenTarget = rewriteExecutionSymlinkTarget(
        resolvedSourceRoot,
        resolvedDestinationRoot,
        entry.path,
        entry.target
      );
      fs.symlinkSync(
        rewrittenTarget,
        destination,
        sourceSymlinkType(resolvedSourceRoot, entry.path, entry.target)
      );
    }
  }
}

export function isPathContainedBy(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const comparableRoot = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
  const comparableCandidate = process.platform === "win32" ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  const relative = path.relative(comparableRoot, comparableCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isSafeWorkspaceSymlink(root: string, relativePath: string, target: string): boolean {
  const linkPath = path.join(path.resolve(root), fromRepositoryPath(relativePath));
  const resolvedTarget = path.resolve(path.dirname(linkPath), target);
  return isPathContainedBy(root, resolvedTarget);
}

/**
 * Absolute links are rooted in the source checkout and must be translated when
 * copied. Leaving one unchanged would turn the execution copy into a write
 * capability for the control workspace.
 */
export function rewriteExecutionSymlinkTarget(
  sourceRoot: string,
  executionRoot: string,
  relativePath: string,
  target: string
): string {
  if (!isSafeWorkspaceSymlink(sourceRoot, relativePath, target)) {
    throw new Error(`Workspace symlink escapes source root: ${relativePath}`);
  }
  if (!path.isAbsolute(target)) return target;

  const sourceTarget = path.resolve(path.dirname(path.join(path.resolve(sourceRoot), fromRepositoryPath(relativePath))), target);
  const relativeTarget = path.relative(path.resolve(sourceRoot), sourceTarget);
  return path.join(path.resolve(executionRoot), relativeTarget);
}

function toRepositoryPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function fromRepositoryPath(filePath: string): string {
  return filePath.split("/").join(path.sep);
}

function resolveWorkspaceEntryPath(root: string, repositoryPath: string): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, fromRepositoryPath(repositoryPath));
  if (!isPathContainedBy(resolvedRoot, candidate) || pathsEqual(resolvedRoot, candidate)) {
    throw new Error(`Workspace manifest entry escapes root: ${repositoryPath}`);
  }
  return candidate;
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function pathsEqual(first: string, second: string): boolean {
  return process.platform === "win32"
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

function sourceSymlinkType(sourceRoot: string, relativePath: string, target: string): fs.symlink.Type | undefined {
  if (process.platform !== "win32") return undefined;
  const linkPath = path.join(path.resolve(sourceRoot), fromRepositoryPath(relativePath));
  const targetPath = path.resolve(path.dirname(linkPath), target);
  try {
    return fs.statSync(targetPath).isDirectory() ? "junction" : "file";
  } catch (error) {
    if (isNotFoundError(error)) return "file";
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
