import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { renameWithWindowsRetry } from "../core/atomic-file.js";
import { captureWorkspaceManifest, isPathContainedBy, type WorkspaceManifest } from "../core/execution-workspace.js";
import { findOutOfScopePaths } from "../core/path-scope.js";

const OWNER_FILE = "codex-mimo-merge-transaction.json";
const JOURNAL_VERSION = 1;

export interface MergeTransactionSnapshot {
  controlRoot: string;
  sourceRef: string;
  targetRef: string;
  sourceOid: string;
  targetOid: string;
  currentBranch: string;
  currentBranchOid: string;
  workspace: WorkspaceManifest;
  cachedPatchSha256: string;
  refs: Record<string, string>;
  worktrees: string[];
  alreadyIntegrated: boolean;
}

export interface CaptureMergeSnapshotInput {
  sourceRef: string;
  targetRef: string;
}

export interface PreparedMergeExecutionWorktree {
  transactionId: string;
  jobId: string;
  controlRoot: string;
  executionRoot: string;
  snapshot: MergeTransactionSnapshot;
  ownerMetadataPath: string;
  ownerToken: string;
}

export interface PrepareMergeExecutionWorktreeInput extends CaptureMergeSnapshotInput {
  jobId: string;
  executionRoot: string;
  transactionId?: string;
}

export interface HostMergeResult {
  status: "started" | "conflicted" | "already_integrated";
}

export interface CommitMergeInput {
  prepared: PreparedMergeExecutionWorktree;
  allowedPaths: string[];
  author?: { name: string; email: string };
}

export interface CommittedMerge {
  mergeOid: string;
  changedFiles: string[];
}

export interface MergeTransactionJournal {
  version: number;
  transactionId: string;
  jobId: string;
  status: "ready" | "published";
  snapshot: MergeTransactionSnapshot;
  mergeOid?: string;
  integrationRef?: string;
  createdAt: string;
}

export interface PublishIntegrationBranchInput {
  prepared: PreparedMergeExecutionWorktree;
  merge: CommittedMerge;
  integrationRef?: string;
  journalDirectory?: string;
  /** Test-only interruption point between a successful CAS and journal finalization. */
  onAfterPublishCas?: () => void;
}

export interface PublishedIntegrationBranch {
  integrationRef: string;
  journalPath: string;
}

/** The deterministic journal location is durable recovery metadata, not secret material. */
export function defaultMergeTransactionJournalPath(prepared: PreparedMergeExecutionWorktree): string {
  validatePrepared(prepared);
  return path.join(resolveGitDir(prepared.controlRoot), "codex-mimo-merge-transactions", `${prepared.transactionId}.json`);
}

/** The ref CAS may have completed even though journal finalization was interrupted. */
export class MergePublicationUncertainError extends Error {
  constructor(readonly journalPath: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "MergePublicationUncertainError";
  }
}

export interface MergeTransactionJournalEvidence {
  journal: MergeTransactionJournal;
  publication: "not_published" | "published" | "inconsistent";
  reason?: string;
}

interface OwnerMetadata {
  version: 1;
  transactionId: string;
  jobId: string;
  controlRoot: string;
  executionRoot: string;
  ownerToken: string;
}

/** Accept only a local branch name; merge transactions never accept revisions. */
export function normalizeLocalBranchRef(cwd: string, candidate: string): string {
  if (typeof candidate !== "string" || !candidate || candidate.includes("\0") || candidate.includes("..")) {
    throw new Error("Merge branch must be a non-empty local branch name");
  }
  const shortName = candidate.startsWith("refs/heads/") ? candidate.slice("refs/heads/".length) : candidate;
  if (!shortName || candidate.startsWith("refs/") && !candidate.startsWith("refs/heads/") || shortName.startsWith("origin/")) {
    throw new Error("Merge branch must be a local branch, not a remote or revision");
  }
  if (/^(HEAD|@|[0-9a-f]{7,64})$/i.test(shortName) || /[~^:{}?*\\[\s]/.test(shortName)) {
    throw new Error("Merge branch must not be HEAD, an object ID, or a revision expression");
  }
  try {
    runGit(cwd, ["check-ref-format", "--branch", shortName]);
  } catch {
    throw new Error(`Invalid local merge branch: ${candidate}`);
  }
  return `refs/heads/${shortName}`;
}

export function captureMergeSnapshot(controlRoot: string, input: CaptureMergeSnapshotInput): MergeTransactionSnapshot {
  const root = validateControlRoot(controlRoot);
  const sourceRef = normalizeLocalBranchRef(root, input.sourceRef);
  const targetRef = normalizeLocalBranchRef(root, input.targetRef);
  const sourceOid = resolveRef(root, sourceRef);
  const targetOid = resolveRef(root, targetRef);
  if (sourceRef === targetRef) throw new Error("Merge source and target branches must be distinct");
  const currentBranch = runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
  const currentBranchOid = resolveRef(root, `refs/heads/${currentBranch}`);
  const workspace = captureWorkspaceManifest(root);
  const cachedPatchSha256 = digest(runGit(root, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff"]));
  const snapshot: MergeTransactionSnapshot = {
    controlRoot: root,
    sourceRef,
    targetRef,
    sourceOid,
    targetOid,
    currentBranch,
    currentBranchOid,
    workspace,
    cachedPatchSha256,
    refs: captureRefs(root),
    worktrees: captureWorktrees(root),
    alreadyIntegrated: isAncestor(root, sourceOid, targetOid)
  };
  return snapshot;
}

/** Creates a clean detached worktree at the pinned target; control edits are deliberately not overlaid. */
export function prepareMergeExecutionWorktree(
  controlRoot: string,
  input: PrepareMergeExecutionWorktreeInput
): PreparedMergeExecutionWorktree {
  const snapshot = captureMergeSnapshot(controlRoot, input);
  return prepareMergeExecutionWorktreeFromSnapshot(snapshot, input);
}

/**
 * Materializes an execution worktree from the launch-time snapshot.  Callers
 * must use this for queued jobs so a ref movement between launch and worker
 * start fails closed rather than silently changing the merge input.
 */
export function prepareMergeExecutionWorktreeFromSnapshot(
  snapshot: MergeTransactionSnapshot,
  input: Omit<PrepareMergeExecutionWorktreeInput, "sourceRef" | "targetRef">
): PreparedMergeExecutionWorktree {
  const controlRoot = validateControlRoot(snapshot.controlRoot);
  if (!pathsEqual(controlRoot, snapshot.controlRoot)) throw new Error("Merge transaction snapshot control root is invalid");
  const executionRoot = validateNewExecutionRoot(snapshot.controlRoot, input.executionRoot);
  const transactionId = input.transactionId ?? crypto.randomUUID();
  const ownerToken = crypto.randomUUID();
  let added = false;
  try {
    assertSnapshotUnchanged(snapshot);
    runGit(snapshot.controlRoot, ["worktree", "add", "--detach", executionRoot, snapshot.targetOid]);
    added = true;
    assertSnapshotUnchanged(snapshot, executionRoot);
    const ownerMetadataPath = path.join(resolveGitDir(executionRoot), OWNER_FILE);
    writeAtomicJson(ownerMetadataPath, {
      version: 1,
      transactionId,
      jobId: input.jobId,
      controlRoot: snapshot.controlRoot,
      executionRoot,
      ownerToken
    } satisfies OwnerMetadata);
    return { transactionId, jobId: input.jobId, controlRoot: snapshot.controlRoot, executionRoot, snapshot, ownerMetadataPath, ownerToken };
  } catch (error) {
    if (added) {
      try { removeRegisteredWorktree(snapshot.controlRoot, executionRoot); } catch { /* retain primary error */ }
    }
    throw error;
  }
}

export function startHostMerge(prepared: PreparedMergeExecutionWorktree): HostMergeResult {
  validatePrepared(prepared);
  assertSnapshotUnchanged(prepared.snapshot, prepared.executionRoot);
  if (prepared.snapshot.alreadyIntegrated) return { status: "already_integrated" };
  const result = runGitResult(prepared.executionRoot, ["merge", "--no-ff", "--no-commit", prepared.snapshot.sourceOid]);
  if (result.exitCode === 0) return { status: "started" };
  if (hasMergeHead(prepared.executionRoot)) return { status: "conflicted" };
  throw new Error(`Host merge failed before entering a merge state: ${result.detail}`);
}

/** Commit only a host-started merge. The agent may resolve content but never publishes a ref. */
export function validateAndCommitMerge(input: CommitMergeInput): CommittedMerge {
  const prepared = input.prepared;
  validatePrepared(prepared);
  assertSnapshotUnchanged(prepared.snapshot, prepared.executionRoot);
  if (resolveHead(prepared.executionRoot) !== prepared.snapshot.targetOid) {
    throw new Error("Merge transaction execution HEAD changed before host commit");
  }
  const mergeHead = tryGit(prepared.executionRoot, ["rev-parse", "--verify", "MERGE_HEAD"]);
  if (mergeHead !== prepared.snapshot.sourceOid) throw new Error("Merge transaction is missing the pinned MERGE_HEAD");
  if (tryGit(prepared.executionRoot, ["ls-files", "-u"])) throw new Error("Merge transaction has unresolved conflicts");
  const status = runGit(prepared.executionRoot, ["status", "--porcelain=v1"]);
  if (status.split(/\r?\n/).some((line) =>
    !isBridgeRuntimeStatusLine(line) && (line.startsWith(" ") || line.startsWith("??")))) {
    throw new Error("Merge transaction has unstaged or untracked changes");
  }
  const staged = changedFromIndex(prepared.executionRoot, prepared.snapshot.targetOid);
  const outOfScope = findOutOfScopePaths(staged, input.allowedPaths);
  if (outOfScope.length) throw new Error(`Merge transaction changed paths outside scope: ${outOfScope.join(", ")}`);
  const env = input.author ? { GIT_AUTHOR_NAME: input.author.name, GIT_AUTHOR_EMAIL: input.author.email, GIT_COMMITTER_NAME: input.author.name, GIT_COMMITTER_EMAIL: input.author.email } : undefined;
  const commit = runGitResult(prepared.executionRoot, ["commit", "--no-verify", "--no-edit"], env);
  if (commit.exitCode !== 0) throw new Error(`Merge commit failed: ${commit.detail}`);
  const mergeOid = resolveHead(prepared.executionRoot);
  const parents = runGit(prepared.executionRoot, ["show", "-s", "--format=%P", mergeOid]).trim().split(/\s+/).filter(Boolean);
  if (parents.length !== 2 || parents[0] !== prepared.snapshot.targetOid || parents[1] !== prepared.snapshot.sourceOid) {
    throw new Error("Committed merge does not have the pinned target and source as its exact parents");
  }
  if (runGit(prepared.executionRoot, ["rev-list", "--first-parent", "--count", `${prepared.snapshot.targetOid}..${mergeOid}`]).trim() !== "1") {
    throw new Error("Merge transaction contains an unexpected first-parent commit");
  }
  const changedFiles = changedByMerge(prepared.executionRoot, mergeOid);
  const committedOutOfScope = findOutOfScopePaths(changedFiles, input.allowedPaths);
  if (committedOutOfScope.length) throw new Error(`Committed merge changed paths outside scope: ${committedOutOfScope.join(", ")}`);
  assertSnapshotUnchanged(prepared.snapshot, prepared.executionRoot);
  return { mergeOid, changedFiles };
}

/** Writes durable ready evidence before a fail-closed create-only integration ref. */
export function publishIntegrationBranch(input: PublishIntegrationBranchInput): PublishedIntegrationBranch {
  const prepared = input.prepared;
  validatePrepared(prepared);
  assertSnapshotUnchanged(prepared.snapshot, prepared.executionRoot);
  const integrationRef = input.integrationRef ?? `refs/heads/codex-mimo/merge/${prepared.jobId}`;
  const normalizedIntegration = normalizeIntegrationRef(prepared.controlRoot, integrationRef);
  const mergeParents = runGit(prepared.executionRoot, ["show", "-s", "--format=%P", input.merge.mergeOid]).trim().split(/\s+/).filter(Boolean);
  if (mergeParents.length !== 2 || mergeParents[0] !== prepared.snapshot.targetOid || mergeParents[1] !== prepared.snapshot.sourceOid) {
    throw new Error("Cannot publish an unverified merge commit");
  }
  const journalPath = input.journalDirectory
    ? path.join(input.journalDirectory, `${prepared.transactionId}.json`)
    : defaultMergeTransactionJournalPath(prepared);
  const directory = path.dirname(journalPath);
  const journal: MergeTransactionJournal = { version: JOURNAL_VERSION, transactionId: prepared.transactionId, jobId: prepared.jobId, status: "ready", snapshot: prepared.snapshot, mergeOid: input.merge.mergeOid, integrationRef: normalizedIntegration, createdAt: new Date().toISOString() };
  fs.mkdirSync(directory, { recursive: true });
  writeAtomicJson(journalPath, journal);
  assertSnapshotUnchanged(prepared.snapshot, prepared.executionRoot);
  const transaction = [
    "start",
    `verify ${prepared.snapshot.sourceRef} ${prepared.snapshot.sourceOid}`,
    `verify ${prepared.snapshot.targetRef} ${prepared.snapshot.targetOid}`,
    // `create` is the create-only CAS primitive in the --stdin transaction.
    // It rejects an existing ref atomically without requiring a SHA-width
    // specific zero object ID.
    `create ${normalizedIntegration} ${input.merge.mergeOid}`,
    "prepare",
    "commit",
    ""
  ].join("\n");
  const published = runGitResult(prepared.controlRoot, ["update-ref", "--stdin"], undefined, transaction);
  if (published.exitCode !== 0) throw new Error(`Integration branch already exists or could not be published: ${published.detail}`);
  try {
    input.onAfterPublishCas?.();
    journal.status = "published";
    writeAtomicJson(journalPath, journal);
  } catch (error) {
    throw new MergePublicationUncertainError(journalPath, error);
  }
  return { integrationRef: normalizedIntegration, journalPath };
}

export function readMergeTransactionJournal(journalPath: string): MergeTransactionJournal {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(journalPath, "utf8")); } catch { throw new Error("Merge transaction journal is missing or invalid"); }
  if (!value || typeof value !== "object") throw new Error("Merge transaction journal is invalid");
  const journal = value as Partial<MergeTransactionJournal>;
  if (journal.version !== JOURNAL_VERSION || typeof journal.transactionId !== "string" || typeof journal.jobId !== "string" || (journal.status !== "ready" && journal.status !== "published") || !journal.snapshot || typeof journal.snapshot !== "object") throw new Error("Merge transaction journal is invalid");
  return journal as MergeTransactionJournal;
}

/**
 * Recovery is deliberately evidence-only: it never publishes, deletes, or
 * moves a ref. A ready journal with the expected integration ref proves that
 * the CAS succeeded but journal finalization was interrupted.
 */
export function validateMergeTransactionJournalEvidence(
  controlRoot: string,
  journalPath: string
): MergeTransactionJournalEvidence {
  const journal = readMergeTransactionJournal(journalPath);
  try {
    const root = validateControlRoot(controlRoot);
    if (!pathsEqual(root, journal.snapshot.controlRoot) || !journal.mergeOid || !journal.integrationRef) {
      return { journal, publication: "inconsistent", reason: "Journal does not include publish evidence" };
    }
    if (resolveRef(root, journal.snapshot.sourceRef) !== journal.snapshot.sourceOid || resolveRef(root, journal.snapshot.targetRef) !== journal.snapshot.targetOid) {
      return { journal, publication: "inconsistent", reason: "Source or target ref moved after the snapshot" };
    }
    const parents = runGit(root, ["show", "-s", "--format=%P", journal.mergeOid]).trim().split(/\s+/).filter(Boolean);
    if (parents.length !== 2 || parents[0] !== journal.snapshot.targetOid || parents[1] !== journal.snapshot.sourceOid) {
      return { journal, publication: "inconsistent", reason: "Journal merge commit does not have pinned parents" };
    }
    const integration = tryGit(root, ["rev-parse", "--verify", `${journal.integrationRef}^{commit}`]);
    if (!integration) return { journal, publication: "not_published" };
    if (integration !== journal.mergeOid) return { journal, publication: "inconsistent", reason: "Integration ref points at a different commit" };
    return { journal, publication: "published" };
  } catch (error) {
    return { journal, publication: "inconsistent", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Owner-safe cleanup; it never recursively deletes a path merely because it was requested. */
export function disposeMergeExecutionWorktree(prepared: PreparedMergeExecutionWorktree, options: { retain?: boolean } = {}): void {
  if (options.retain) return;
  validatePrepared(prepared);
  removeRegisteredWorktree(prepared.controlRoot, prepared.executionRoot);
}

function validatePrepared(prepared: PreparedMergeExecutionWorktree): void {
  const root = validateControlRoot(prepared.controlRoot);
  if (!pathsEqual(root, prepared.snapshot.controlRoot) || !pathsEqual(root, prepared.controlRoot)) throw new Error("Merge transaction control root does not match snapshot");
  const executionRoot = path.resolve(prepared.executionRoot);
  const executionStat = fs.existsSync(executionRoot) ? fs.lstatSync(executionRoot) : undefined;
  if (!executionStat?.isDirectory() || executionStat.isSymbolicLink() || pathsEqual(root, executionRoot) || isPathContainedBy(root, executionRoot) || isPathContainedBy(executionRoot, root)) throw new Error("Merge execution worktree is missing or unsafe");
  if (!captureWorktrees(root).some((candidate) => pathsEqual(candidate, executionRoot))) throw new Error("Merge execution worktree is no longer registered by the control repository");
  if (!pathsEqual(resolveCommonGitDir(root), resolveCommonGitDir(executionRoot))) throw new Error("Merge execution worktree does not share the control Git common directory");
  const expected = path.join(resolveGitDir(executionRoot), OWNER_FILE);
  if (!pathsEqual(expected, prepared.ownerMetadataPath)) throw new Error("Merge owner metadata path is invalid");
  let metadata: unknown;
  try { metadata = JSON.parse(fs.readFileSync(expected, "utf8")); } catch { throw new Error("Merge owner metadata is missing or invalid"); }
  const owner = metadata as Partial<OwnerMetadata>;
  if (owner.version !== 1 || owner.transactionId !== prepared.transactionId || owner.jobId !== prepared.jobId || owner.ownerToken !== prepared.ownerToken || !pathsEqual(owner.controlRoot ?? "", root) || !pathsEqual(owner.executionRoot ?? "", executionRoot)) throw new Error("Merge owner metadata does not match transaction");
}

function assertSnapshotUnchanged(snapshot: MergeTransactionSnapshot, allowedExecutionRoot?: string): void {
  const current = captureMergeSnapshot(snapshot.controlRoot, { sourceRef: snapshot.sourceRef, targetRef: snapshot.targetRef });
  const worktrees = allowedExecutionRoot
    ? current.worktrees.filter((entry) => !pathsEqual(entry, allowedExecutionRoot))
    : current.worktrees;
  if (current.sourceOid !== snapshot.sourceOid || current.targetOid !== snapshot.targetOid || current.currentBranch !== snapshot.currentBranch || current.currentBranchOid !== snapshot.currentBranchOid || current.cachedPatchSha256 !== snapshot.cachedPatchSha256 || JSON.stringify(current.workspace.entries) !== JSON.stringify(snapshot.workspace.entries) || JSON.stringify(current.refs) !== JSON.stringify(snapshot.refs) || JSON.stringify(worktrees) !== JSON.stringify(snapshot.worktrees)) {
    throw new Error("Control workspace, index, refs, or worktree registrations changed during merge transaction");
  }
}

function validateControlRoot(controlRoot: string): string {
  const root = path.resolve(controlRoot);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Control workspace must be a real directory: ${root}`);
  const top = runGit(root, ["rev-parse", "--show-toplevel"]).trim();
  if (!pathsEqual(path.resolve(top), root)) throw new Error("Control workspace must be the Git worktree root");
  resolveHead(root);
  return root;
}

function validateNewExecutionRoot(controlRoot: string, executionRoot: string): string {
  const resolved = path.resolve(executionRoot);
  if (pathsEqual(controlRoot, resolved) || isPathContainedBy(controlRoot, resolved) || isPathContainedBy(resolved, controlRoot) || pathsEqual(resolved, path.parse(resolved).root) || fs.existsSync(resolved)) throw new Error("Merge execution worktree must be a new, separate directory");
  return resolved;
}

function normalizeIntegrationRef(cwd: string, value: string): string {
  if (!value.startsWith("refs/heads/codex-mimo/merge/")) throw new Error("Integration branch must be under refs/heads/codex-mimo/merge/");
  const short = value.slice("refs/heads/".length);
  try { runGit(cwd, ["check-ref-format", "--branch", short]); } catch { throw new Error("Invalid integration branch"); }
  return `refs/heads/${short}`;
}

function captureRefs(cwd: string): Record<string, string> {
  const lines = runGit(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)"]).split(/\r?\n/).filter(Boolean);
  return Object.fromEntries(lines.map((line) => { const [ref, oid] = line.split("\0"); return [ref, oid]; }));
}

function captureWorktrees(cwd: string): string[] {
  return runGit(cwd, ["worktree", "list", "--porcelain"]).split(/\r?\n/).filter((line) => line.startsWith("worktree ")).map((line) => path.resolve(line.slice(9))).sort();
}

function changedFromIndex(cwd: string, targetOid: string): string[] { return lines(runGit(cwd, ["diff", "--cached", "--name-only", targetOid])); }
function changedByMerge(cwd: string, mergeOid: string): string[] { return lines(runGit(cwd, ["diff-tree", "-m", "--first-parent", "--no-commit-id", "-r", "--name-only", mergeOid])); }
function isBridgeRuntimeStatusLine(line: string): boolean {
  const candidate = line.slice(3).replace(/\\/g, "/");
  return candidate === ".codex-mimo" || candidate.startsWith(".codex-mimo/") ||
    candidate === ".mimocode/.cron-lock";
}
function lines(value: string): string[] { return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }
function resolveRef(cwd: string, ref: string): string { return runGit(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]).trim(); }
function resolveHead(cwd: string): string { return runGit(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]).trim(); }
function isAncestor(cwd: string, ancestor: string, descendant: string): boolean { return runGitResult(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).exitCode === 0; }
function hasMergeHead(cwd: string): boolean { return runGitResult(cwd, ["rev-parse", "--verify", "MERGE_HEAD"]).exitCode === 0; }
function tryGit(cwd: string, args: string[]): string { const result = runGitResult(cwd, args); return result.exitCode === 0 ? result.stdout.trim() : ""; }
function resolveGitDir(cwd: string): string { return path.resolve(runGit(cwd, ["rev-parse", "--absolute-git-dir"]).trim()); }
function resolveCommonGitDir(cwd: string): string { return path.resolve(cwd, runGit(cwd, ["rev-parse", "--git-common-dir"]).trim()); }
function digest(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
/** Supports SHA-1 and SHA-256 repositories without guessing their object format. */
export function zeroOidFor(oid: string): string {
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(oid)) throw new Error("Merge object ID must be a SHA-1 or SHA-256 object ID");
  return "0".repeat(oid.length);
}
function writeAtomicJson(filePath: string, value: unknown): void { const temporary = `${filePath}.${crypto.randomUUID()}.tmp`; try { fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8"); renameWithWindowsRetry(temporary, filePath); } finally { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); } }
function removeRegisteredWorktree(controlRoot: string, executionRoot: string): void { if (!captureWorktrees(controlRoot).some((entry) => pathsEqual(entry, executionRoot))) throw new Error("Merge execution worktree is not registered"); runGit(controlRoot, ["worktree", "remove", "--force", executionRoot]); runGit(controlRoot, ["worktree", "prune"]); }
function pathsEqual(first: string, second: string): boolean { return process.platform === "win32" ? path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase() : path.resolve(first) === path.resolve(second); }
function runGit(cwd: string, args: string[], env?: Record<string, string>): string { const result = runGitResult(cwd, args, env); if (result.exitCode !== 0) throw new Error(`Git command failed (${args.join(" ")}): ${result.detail}`); return result.stdout; }
function runGitResult(cwd: string, args: string[], env?: Record<string, string>, input?: string): { exitCode: number; stdout: string; detail: string } { try { const stdout = execFileSync("git", ["-c", `safe.directory=${path.resolve(cwd).replace(/\\/g, "/")}`, ...args], { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_EDITOR: "true", ...(env ?? {}) } }); return { exitCode: 0, stdout, detail: "" }; } catch (error) { const captured = error as NodeJS.ErrnoException & { status?: number; stdout?: string | Buffer; stderr?: string | Buffer }; const stderr = captured.stderr ? String(captured.stderr).trim() : ""; return { exitCode: captured.status ?? 1, stdout: captured.stdout ? String(captured.stdout) : "", detail: stderr || captured.message }; } }
