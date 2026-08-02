import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { renameWithWindowsRetry } from "./atomic-file.js";
import {
  captureWorkspaceManifest,
  isPathContainedBy,
  isSafeWorkspaceSymlink,
  type WorkspaceEntry,
  type WorkspaceManifest
} from "./execution-workspace.js";
import { isPathWithinAllowedScope } from "./path-scope.js";
import { isRuntimeArtifactPath } from "./runtime-paths.js";

export interface UpsertFilePromotionOperation {
  kind: "upsert_file";
  path: string;
  sha256: string;
  size: number;
}

export interface UpsertSymlinkPromotionOperation {
  kind: "upsert_symlink";
  path: string;
  target: string;
  /** The resolved target type captured from the execution workspace. */
  targetKind?: "directory" | "file";
}

export interface MakeDirectoryPromotionOperation {
  kind: "mkdir";
  path: string;
}

export interface DeletePromotionOperation {
  kind: "delete";
  path: string;
}

export type PromotionOperation =
  | UpsertFilePromotionOperation
  | UpsertSymlinkPromotionOperation
  | MakeDirectoryPromotionOperation
  | DeletePromotionOperation;

export type PromotionFailureCode =
  | "promotion_scope_violation"
  | "promotion_unsafe_symlink"
  | "promotion_conflict"
  | "promotion_apply_failed";

export interface WorkspacePromotionPlanInput {
  baseline: WorkspaceManifest;
  executionRoot: string;
  /** Undefined preserves the caller's existing scope policy; [] permits no source paths. */
  allowedPaths?: string[];
  artifactPaths?: string[];
}

export interface WorkspacePromotionPlan {
  passed: boolean;
  operations: PromotionOperation[];
  artifactFiles: string[];
  outOfScopePaths: string[];
  failureCode?: "promotion_scope_violation" | "promotion_unsafe_symlink";
  reason?: string;
}

export interface ApplyWorkspacePromotionInput {
  controlRoot: string;
  executionRoot: string;
  baseline: WorkspaceManifest;
  plan: WorkspacePromotionPlan;
  journalDirectory?: string;
}

export interface AppliedWorkspacePromotion {
  passed: boolean;
  appliedPaths: string[];
  artifactFiles: string[];
  conflictPaths: string[];
  failureCode?: PromotionFailureCode;
  journalPath?: string;
  reason?: string;
}

interface PromotionJournal {
  id: string;
  status: "planned" | "applying" | "applied" | "rolled_back" | "failed";
  operations: PromotionOperation[];
  appliedPaths: string[];
  backupRoot: string;
  createdAt: string;
}

interface BackupRecord {
  path: string;
  backupPath: string;
  kind: "moved" | "empty_directory";
}

/**
 * Calculates the exact source-tree changes made in an isolated workspace. A
 * rename naturally becomes delete + upsert, which makes replay portable.
 */
export function createWorkspacePromotionPlan(input: WorkspacePromotionPlanInput): WorkspacePromotionPlan {
  const execution = captureWorkspaceManifest(input.executionRoot, {
    maxEntries: Math.max(input.baseline.entries.length + 1, 100_000)
  });
  const baselineEntries = new Map(input.baseline.entries.map((entry) => [entry.path, entry]));
  const executionEntries = new Map(execution.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...baselineEntries.keys(), ...executionEntries.keys()])].sort();
  const candidates: PromotionOperation[] = [];

  for (const relativePath of paths) {
    const before = baselineEntries.get(relativePath);
    const executionAfter = executionEntries.get(relativePath);
    const after = normalizeExecutionEntry(input, executionAfter);
    if (entriesEqual(before, after)) continue;

    if (before && after && before.kind !== after.kind) {
      candidates.push({ kind: "delete", path: relativePath });
    }

    if (after?.kind === "file") {
      candidates.push({ kind: "upsert_file", path: relativePath, sha256: after.sha256, size: after.size });
    } else if (after?.kind === "symlink") {
      if (!executionAfter || executionAfter.kind !== "symlink") {
        throw new Error(`Execution symlink manifest entry is missing: ${relativePath}`);
      }
      if (!isSafeWorkspaceSymlink(input.executionRoot, after.path, executionAfter.target)) {
        return failedPlan("promotion_unsafe_symlink", `Execution symlink escapes workspace: ${after.path}`);
      }
      candidates.push({
        kind: "upsert_symlink",
        path: relativePath,
        target: after.target,
        targetKind: resolveSymlinkTargetKind(input.executionRoot, after.path)
      });
    } else if (after?.kind === "directory" && (!before || before.kind !== "directory")) {
      candidates.push({ kind: "mkdir", path: relativePath });
    } else if (before && !after) {
      candidates.push({ kind: "delete", path: relativePath });
    }
  }

  const nonRuntimeCandidates = candidates.filter((operation) => !isRuntimeArtifactPath(operation.path));
  const artifactFiles = nonRuntimeCandidates
    .filter((operation) => operation.kind !== "mkdir" && isArtifactPath(operation.path, input.artifactPaths ?? []))
    .map((operation) => operation.path);
  const sourceOperations = nonRuntimeCandidates
    .filter((operation) => !isArtifactPath(operation.path, input.artifactPaths ?? []));
  const outOfScopePaths = input.allowedPaths === undefined
    ? []
    : sourceOperations
      .filter((operation) => !isPathWithinAllowedScope(operation.path, input.allowedPaths ?? []))
      .map((operation) => operation.path);
  if (outOfScopePaths.length > 0) {
    return {
      passed: false,
      operations: [],
      artifactFiles,
      outOfScopePaths,
      failureCode: "promotion_scope_violation",
      reason: `Execution workspace changed paths outside the allowed scope: ${outOfScopePaths.join(", ")}`
    };
  }

  return {
    passed: true,
    operations: orderOperations(sourceOperations),
    artifactFiles,
    outOfScopePaths: []
  };
}

/**
 * Replays an approved plan only when every target still has its captured
 * baseline state. The journal and moved backups make a failed replay recoverable.
 */
export function applyWorkspacePromotion(input: ApplyWorkspacePromotionInput): AppliedWorkspacePromotion {
  if (!input.plan.passed) {
    return {
      passed: false,
      appliedPaths: [],
      artifactFiles: input.plan.artifactFiles,
      conflictPaths: [],
      failureCode: input.plan.failureCode ?? "promotion_apply_failed",
      reason: input.plan.reason
    };
  }

  const controlRoot = path.resolve(input.controlRoot);
  const executionRoot = path.resolve(input.executionRoot);
  try {
    validatePromotionOperations(input.plan.operations);
  } catch (error) {
    return {
      passed: false,
      appliedPaths: [],
      artifactFiles: input.plan.artifactFiles,
      conflictPaths: [],
      failureCode: "promotion_apply_failed",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  const conflictPaths = findPromotionConflicts(controlRoot, input.baseline, input.plan.operations);
  if (conflictPaths.length > 0) {
    return {
      passed: false,
      appliedPaths: [],
      artifactFiles: input.plan.artifactFiles,
      conflictPaths,
      failureCode: "promotion_conflict",
      reason: `The control workspace changed while execution was running: ${conflictPaths.join(", ")}`
    };
  }

  const journalDirectory = input.journalDirectory ?? path.join(controlRoot, ".codex-mimo", "promotion-journal");
  const journalId = `${Date.now()}-${crypto.randomUUID()}`;
  const backupRoot = path.join(journalDirectory, `${journalId}.backup`);
  const journalPath = path.join(journalDirectory, `${journalId}.json`);
  const journal: PromotionJournal = {
    id: journalId,
    status: "planned",
    operations: input.plan.operations,
    appliedPaths: [],
    backupRoot,
    createdAt: new Date().toISOString()
  };
  fs.mkdirSync(journalDirectory, { recursive: true });
  writeJournal(journalPath, journal);

  const backups: BackupRecord[] = [];
  const expectedEntries = new Map(input.baseline.entries.map((entry) => [entry.path, entry]));
  try {
    journal.status = "applying";
    writeJournal(journalPath, journal);
    for (const operation of input.plan.operations) {
      const operationConflicts = findOperationConflicts(controlRoot, expectedEntries, operation);
      if (operationConflicts.length > 0) throw new PromotionConflictError(operationConflicts);
      const targetPath = resolveWorkspacePath(controlRoot, operation.path);
      const backup = moveTargetToBackup(targetPath, backupRoot, operation.path);
      if (backup) backups.push(backup);

      // Persist intent before materializing a change. If writing this journal
      // record fails, rollback still knows to remove a newly-created target.
      journal.appliedPaths.push(operation.path);
      writeJournal(journalPath, journal);

      if (operation.kind === "upsert_file") {
        const sourcePath = resolveWorkspacePath(executionRoot, operation.path);
        verifyExecutionFile(sourcePath, operation);
        writeFileAtomically(sourcePath, targetPath);
      } else if (operation.kind === "upsert_symlink") {
        if (!isSafeWorkspaceSymlink(controlRoot, operation.path, operation.target)) {
          throw new Error(`Promotion symlink escapes control workspace: ${operation.path}`);
        }
        writeSymlinkAtomically(operation.target, operation.targetKind, targetPath);
      } else if (operation.kind === "mkdir") {
        fs.mkdirSync(targetPath, { recursive: false });
      }
      applyExpectedOperation(expectedEntries, operation);
    }
    journal.status = "applied";
    writeJournal(journalPath, journal);
    return {
      passed: true,
      appliedPaths: journal.appliedPaths,
      artifactFiles: input.plan.artifactFiles,
      conflictPaths: [],
      journalPath
    };
  } catch (error) {
    try {
      rollbackPromotion(controlRoot, journal.appliedPaths, backups, input.plan.operations);
      journal.status = "rolled_back";
    } catch {
      journal.status = "failed";
    }
    writeJournal(journalPath, journal);
    const conflict = error instanceof PromotionConflictError ? error.paths : [];
    return {
      passed: false,
      appliedPaths: [],
      artifactFiles: input.plan.artifactFiles,
      conflictPaths: conflict,
      failureCode: conflict.length > 0 ? "promotion_conflict" : "promotion_apply_failed",
      journalPath,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function failedPlan(
  failureCode: "promotion_unsafe_symlink",
  reason: string
): WorkspacePromotionPlan {
  return { passed: false, operations: [], artifactFiles: [], outOfScopePaths: [], failureCode, reason };
}

function entriesEqual(before: WorkspaceEntry | undefined, after: WorkspaceEntry | undefined): boolean {
  if (!before || !after || before.kind !== after.kind) return false;
  if (before.kind === "directory" || after.kind === "directory") return true;
  if (before.kind === "file" && after.kind === "file") {
    return before.size === after.size && before.sha256 === after.sha256;
  }
  return before.kind === "symlink" && after.kind === "symlink" && before.target === after.target;
}

function isArtifactPath(filePath: string, artifactPaths: string[]): boolean {
  return artifactPaths.some((pattern) => isPathWithinAllowedScope(filePath, [pattern]));
}

function orderOperations(operations: PromotionOperation[]): PromotionOperation[] {
  return [...operations].sort((first, second) => {
    const firstRank = operationRank(first);
    const secondRank = operationRank(second);
    if (firstRank !== secondRank) return firstRank - secondRank;
    const firstDepth = first.path.split("/").length;
    const secondDepth = second.path.split("/").length;
    if (firstDepth !== secondDepth) {
      return first.kind === "delete" ? secondDepth - firstDepth : firstDepth - secondDepth;
    }
    return first.path.localeCompare(second.path);
  });
}

function operationRank(operation: PromotionOperation): number {
  if (operation.kind === "delete") return 0;
  if (operation.kind === "mkdir") return 1;
  return 2;
}

function findPromotionConflicts(
  controlRoot: string,
  baseline: WorkspaceManifest,
  operations: PromotionOperation[]
): string[] {
  const baselineEntries = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  const conflicts = new Set<string>();
  for (const operation of operations) {
    for (const conflict of findOperationConflicts(controlRoot, baselineEntries, operation)) conflicts.add(conflict);
  }
  return [...conflicts].sort();
}

/**
 * Checks the target, its complete expected subtree and structural ancestors.
 * This makes a directory move safe: an untracked user child is a conflict just
 * as a changed captured child would be.
 */
function findOperationConflicts(
  controlRoot: string,
  expectedEntries: Map<string, WorkspaceEntry>,
  operation: PromotionOperation
): string[] {
  const conflicts = new Set<string>();
  const currentSubtree = captureSubtreeEntries(controlRoot, operation.path);
  const paths = new Set<string>([
    ...[...expectedEntries.keys()].filter((entryPath) => isSameOrChildPath(operation.path, entryPath)),
    ...currentSubtree.keys()
  ]);
  for (const entryPath of paths) {
    if (!entriesEqual(expectedEntries.get(entryPath), currentSubtree.get(entryPath))) conflicts.add(entryPath);
  }
  for (const ancestorPath of ancestorPaths(operation.path)) {
    const expected = expectedEntries.get(ancestorPath);
    const current = captureSingleEntry(controlRoot, ancestorPath);
    if (!entriesEqual(expected, current)) conflicts.add(ancestorPath);
  }
  return [...conflicts].sort();
}

function applyExpectedOperation(expectedEntries: Map<string, WorkspaceEntry>, operation: PromotionOperation): void {
  if (operation.kind === "delete") {
    expectedEntries.delete(operation.path);
    return;
  }
  if (operation.kind === "mkdir") {
    expectedEntries.set(operation.path, { kind: "directory", path: operation.path });
    return;
  }
  if (operation.kind === "upsert_file") {
    expectedEntries.set(operation.path, {
      kind: "file",
      path: operation.path,
      sha256: operation.sha256,
      size: operation.size
    });
    return;
  }
  expectedEntries.set(operation.path, { kind: "symlink", path: operation.path, target: operation.target });
}

function isSameOrChildPath(parentPath: string, candidatePath: string): boolean {
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`);
}

function ancestorPaths(relativePath: string): string[] {
  const segments = relativePath.split("/");
  const ancestors: string[] = [];
  for (let index = 1; index < segments.length; index += 1) ancestors.push(segments.slice(0, index).join("/"));
  return ancestors;
}

function captureSingleEntry(root: string, relativePath: string): WorkspaceEntry | undefined {
  const absolutePath = resolveWorkspacePath(root, relativePath);
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      return { kind: "symlink", path: relativePath, target: fs.readlinkSync(absolutePath) };
    }
    if (stat.isDirectory()) return { kind: "directory", path: relativePath };
    if (stat.isFile()) {
      return { kind: "file", path: relativePath, size: stat.size, sha256: sha256File(absolutePath) };
    }
    throw new Error(`Unsupported workspace entry type: ${absolutePath}`);
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

function captureSubtreeEntries(root: string, relativePath: string): Map<string, WorkspaceEntry> {
  const entries = new Map<string, WorkspaceEntry>();
  const visit = (entryPath: string): void => {
    const entry = captureSingleEntry(root, entryPath);
    if (!entry) return;
    entries.set(entryPath, entry);
    if (entry.kind !== "directory") return;
    const directoryPath = resolveWorkspacePath(root, entryPath);
    for (const childName of fs.readdirSync(directoryPath).sort()) {
      visit(`${entryPath}/${childName}`);
    }
  };
  visit(relativePath);
  return entries;
}

function normalizeExecutionEntry(
  input: WorkspacePromotionPlanInput,
  entry: WorkspaceEntry | undefined
): WorkspaceEntry | undefined {
  if (!entry || entry.kind !== "symlink" || !isAbsolutePath(entry.target)) return entry;
  const targetPath = path.resolve(
    path.dirname(resolveWorkspacePath(input.executionRoot, entry.path)),
    entry.target
  );
  if (!isPathContainedBy(input.executionRoot, targetPath)) return entry;
  const relativeTarget = path.relative(path.resolve(input.executionRoot), targetPath);
  return {
    ...entry,
    target: path.join(path.resolve(input.baseline.rootPath), relativeTarget)
  };
}

function resolveSymlinkTargetKind(executionRoot: string, relativePath: string): "directory" | "file" | undefined {
  const linkPath = resolveWorkspacePath(executionRoot, relativePath);
  try {
    return fs.statSync(linkPath).isDirectory() ? "directory" : "file";
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

function resolveWorkspacePath(root: string, relativePath: string): string {
  validatePromotionPath(relativePath);
  const resolved = path.resolve(root, relativePath.split("/").join(path.sep));
  if (!isPathContainedBy(root, resolved)) {
    throw new Error(`Promotion path escapes workspace: ${relativePath}`);
  }
  return resolved;
}

function validatePromotionOperations(operations: PromotionOperation[]): void {
  for (const operation of operations) {
    if (!operation || typeof operation !== "object") throw new Error("Promotion operation must be an object");
    validatePromotionPath(operation.path);
    if (operation.kind === "upsert_file") {
      if (!Number.isSafeInteger(operation.size) || operation.size < 0 || !/^[a-f0-9]{64}$/i.test(operation.sha256)) {
        throw new Error(`Invalid file promotion operation: ${operation.path}`);
      }
    } else if (operation.kind === "upsert_symlink") {
      if (typeof operation.target !== "string" || operation.target.includes("\0")) {
        throw new Error(`Invalid symlink promotion operation: ${operation.path}`);
      }
    } else if (operation.kind !== "delete" && operation.kind !== "mkdir") {
      throw new Error(`Unsupported promotion operation: ${(operation as { kind?: unknown }).kind}`);
    }
  }
}

function validatePromotionPath(relativePath: string): void {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\0") ||
      isAbsolutePath(relativePath) || /^[A-Za-z]:/.test(relativePath) || relativePath.includes("\\")) {
    throw new Error(`Invalid promotion path: ${String(relativePath)}`);
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Invalid promotion path: ${relativePath}`);
  }
}

function isAbsolutePath(filePath: string): boolean {
  return path.isAbsolute(filePath) || path.win32.isAbsolute(filePath) || path.posix.isAbsolute(filePath);
}

function moveTargetToBackup(targetPath: string, backupRoot: string, relativePath: string): BackupRecord | undefined {
  if (!fs.existsSync(targetPath) && !isSymlink(targetPath)) return undefined;
  const backupPath = path.join(backupRoot, relativePath.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  if (fs.lstatSync(targetPath).isDirectory() && fs.existsSync(backupPath)) {
    if (fs.readdirSync(targetPath).length !== 0) {
      throw new Error(`Cannot replace a non-empty directory after child promotion: ${relativePath}`);
    }
    fs.rmdirSync(targetPath);
    return { path: targetPath, backupPath, kind: "empty_directory" };
  }
  renameWithWindowsRetry(targetPath, backupPath);
  return { path: targetPath, backupPath, kind: "moved" };
}

function writeFileAtomically(sourcePath: string, targetPath: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.copyFileSync(sourcePath, temporaryPath);
    renameWithWindowsRetry(temporaryPath, targetPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

function writeSymlinkAtomically(
  target: string,
  targetKind: UpsertSymlinkPromotionOperation["targetKind"],
  targetPath: string
): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.symlinkSync(
      target,
      temporaryPath,
      process.platform === "win32" ? (targetKind === "directory" ? "junction" : "file") : undefined
    );
    renameWithWindowsRetry(temporaryPath, targetPath);
  } finally {
    if (fs.existsSync(temporaryPath) || isSymlink(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

function verifyExecutionFile(sourcePath: string, operation: UpsertFilePromotionOperation): void {
  const stat = fs.lstatSync(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== operation.size || sha256File(sourcePath) !== operation.sha256) {
    throw new Error(`Execution file changed before promotion: ${operation.path}`);
  }
}

function rollbackPromotion(
  controlRoot: string,
  appliedPaths: string[],
  backups: BackupRecord[],
  operations: PromotionOperation[]
): void {
  const operationsByPath = new Map(operations.map((operation) => [operation.path, operation]));
  const backupByPath = new Map(backups.map((backup) => [backup.path, backup]));
  for (const relativePath of [...appliedPaths].reverse()) {
    const targetPath = resolveWorkspacePath(controlRoot, relativePath);
    const operation = operationsByPath.get(relativePath);
    const backup = backupByPath.get(targetPath);
    if (!operation) continue;
    const current = captureSingleEntry(controlRoot, relativePath);
    if (matchesPromotionOutput(current, operation)) {
      if (!removePromotionOutput(targetPath, current)) continue;
    } else if (current) {
      // A different process changed this path after promotion began. Leave it
      // untouched and do not overwrite it with a backup during rollback.
      continue;
    }
    if (backup?.kind === "empty_directory") {
      fs.mkdirSync(backup.path, { recursive: true });
    } else if (backup && (fs.existsSync(backup.backupPath) || isSymlink(backup.backupPath))) {
      fs.mkdirSync(path.dirname(backup.path), { recursive: true });
      renameWithWindowsRetry(backup.backupPath, backup.path);
    }
  }
}

function matchesPromotionOutput(current: WorkspaceEntry | undefined, operation: PromotionOperation): boolean {
  if (operation.kind === "delete") return current === undefined;
  if (operation.kind === "mkdir") return current?.kind === "directory";
  if (operation.kind === "upsert_file") {
    return current?.kind === "file" && current.size === operation.size && current.sha256 === operation.sha256;
  }
  return current?.kind === "symlink" && current.target === operation.target;
}

function removePromotionOutput(targetPath: string, current: WorkspaceEntry | undefined): boolean {
  if (!current) return true;
  if (current.kind === "directory") {
    if (fs.readdirSync(targetPath).length > 0) return false;
    fs.rmdirSync(targetPath);
    return true;
  }
  fs.rmSync(targetPath, { force: true });
  return true;
}

class PromotionConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(`The control workspace changed while execution was running: ${paths.join(", ")}`);
  }
}

function writeJournal(journalPath: string, journal: PromotionJournal): void {
  const temporaryPath = `${journalPath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  renameWithWindowsRetry(temporaryPath, journalPath);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isSymlink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const contents = fs.readFileSync(filePath);
  hash.update(contents);
  return hash.digest("hex");
}
