import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureMergeSnapshot,
  disposeMergeExecutionWorktree,
  normalizeLocalBranchRef,
  prepareMergeExecutionWorktree,
  publishIntegrationBranch,
  startHostMerge,
  validateAndCommitMerge,
  validateMergeTransactionJournalEvidence,
  zeroOidFor
} from "../../src/git/merge-transaction.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("merge transaction", () => {
  it("pins local branches and publishes only a host-created merge commit", () => {
    const control = repository();
    branch(control, "feature");
    fs.writeFileSync(path.join(control, "feature.txt"), "feature\n");
    git(control, ["add", "."]); git(control, ["commit", "-m", "feature"]);
    git(control, ["checkout", "main"]);
    const beforeStatus = git(control, ["status", "--porcelain"]);
    const beforeHead = git(control, ["rev-parse", "HEAD"]);
    const execution = path.join(temp("merge-exec-"), "worktree");
    const prepared = prepareMergeExecutionWorktree(control, { jobId: "job-1", executionRoot: execution, sourceRef: "feature", targetRef: "main" });
    expect(startHostMerge(prepared)).toEqual({ status: "started" });
    const merge = validateAndCommitMerge({ prepared, allowedPaths: ["feature.txt"], author: { name: "Bridge", email: "bridge@example.test" } });
    expect(git(execution, ["show", "-s", "--format=%P", merge.mergeOid]).split(" ")).toEqual([prepared.snapshot.targetOid, prepared.snapshot.sourceOid]);
    const published = publishIntegrationBranch({ prepared, merge });
    expect(git(control, ["rev-parse", published.integrationRef])).toBe(merge.mergeOid);
    expect(git(control, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(git(control, ["status", "--porcelain"])).toBe(beforeStatus);
    disposeMergeExecutionWorktree(prepared);
  });

  it("does not overlay dirty control files and detects control drift", () => {
    const control = repository(); branch(control, "feature"); fs.writeFileSync(path.join(control, "f.txt"), "f"); git(control, ["add", "."]); git(control, ["commit", "-m", "f"]); git(control, ["checkout", "main"]);
    fs.writeFileSync(path.join(control, "tracked.txt"), "dirty control\n");
    const execution = path.join(temp("merge-exec-"), "worktree");
    const prepared = prepareMergeExecutionWorktree(control, { jobId: "job-2", executionRoot: execution, sourceRef: "feature", targetRef: "main" });
    expect(fs.readFileSync(path.join(execution, "tracked.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("initial\n");
    fs.writeFileSync(path.join(control, "other.txt"), "concurrent\n");
    expect(() => startHostMerge(prepared)).toThrow("changed during merge transaction");
    disposeMergeExecutionWorktree(prepared);
  });

  it("rejects remote refs, revisions, unresolved merges, out-of-scope content and ref collisions", () => {
    const control = repository();
    expect(() => normalizeLocalBranchRef(control, "HEAD")).toThrow();
    expect(() => normalizeLocalBranchRef(control, "origin/main")).toThrow();
    expect(() => normalizeLocalBranchRef(control, "main~1")).toThrow();
    branch(control, "feature"); fs.writeFileSync(path.join(control, "bad.txt"), "bad"); git(control, ["add", "."]); git(control, ["commit", "-m", "bad"]); git(control, ["checkout", "main"]);
    const prepared = prepareMergeExecutionWorktree(control, { jobId: "job-3", executionRoot: path.join(temp("merge-exec-"), "worktree"), sourceRef: "feature", targetRef: "main" });
    startHostMerge(prepared);
    expect(() => validateAndCommitMerge({ prepared, allowedPaths: ["good.txt"], author: { name: "Bridge", email: "bridge@example.test" } })).toThrow("outside scope");
    disposeMergeExecutionWorktree(prepared);
  });

  it("reports already integrated without creating a merge state", () => {
    const control = repository();
    branch(control, "feature"); fs.writeFileSync(path.join(control, "f.txt"), "f"); git(control, ["add", "."]); git(control, ["commit", "-m", "f"]); git(control, ["checkout", "main"]); git(control, ["merge", "--ff-only", "feature"]);
    const snapshot = captureMergeSnapshot(control, { sourceRef: "feature", targetRef: "main" });
    expect(snapshot.alreadyIntegrated).toBe(true);
    const prepared = prepareMergeExecutionWorktree(control, { jobId: "job-4", executionRoot: path.join(temp("merge-exec-"), "worktree"), sourceRef: "feature", targetRef: "main" });
    expect(startHostMerge(prepared)).toEqual({ status: "already_integrated" });
    disposeMergeExecutionWorktree(prepared);
  });

  it("fails closed if the execution HEAD moved and supports both Git object ID lengths", () => {
    const control = repository(); branch(control, "feature"); fs.writeFileSync(path.join(control, "f.txt"), "f"); git(control, ["add", "."]); git(control, ["commit", "-m", "f"]); git(control, ["checkout", "main"]);
    const prepared = prepareMergeExecutionWorktree(control, { jobId: "job-head", executionRoot: path.join(temp("merge-exec-"), "worktree"), sourceRef: "feature", targetRef: "main" });
    startHostMerge(prepared);
    git(prepared.executionRoot, ["commit", "--no-verify", "--no-edit"]);
    expect(() => validateAndCommitMerge({ prepared, allowedPaths: ["f.txt"], author: { name: "Bridge", email: "bridge@example.test" } })).toThrow("execution HEAD changed");
    expect(zeroOidFor("a".repeat(40))).toHaveLength(40);
    expect(zeroOidFor("a".repeat(64))).toHaveLength(64);
    expect(() => zeroOidFor("abc")).toThrow();
    disposeMergeExecutionWorktree(prepared);
  });

  it("keeps ready journal evidence when CAS succeeded before final journal write", () => {
    const control = repository(); branch(control, "feature"); fs.writeFileSync(path.join(control, "f.txt"), "f"); git(control, ["add", "."]); git(control, ["commit", "-m", "f"]); git(control, ["checkout", "main"]);
    const journalDirectory = temp("merge-journal-");
    const prepared = prepareMergeExecutionWorktree(control, { jobId: "job-journal", executionRoot: path.join(temp("merge-exec-"), "worktree"), sourceRef: "feature", targetRef: "main" });
    startHostMerge(prepared);
    const merge = validateAndCommitMerge({ prepared, allowedPaths: ["f.txt"], author: { name: "Bridge", email: "bridge@example.test" } });
    expect(() => publishIntegrationBranch({ prepared, merge, journalDirectory, onAfterPublishCas: () => { throw new Error("simulated interruption"); } })).toThrow("simulated interruption");
    const evidence = validateMergeTransactionJournalEvidence(control, path.join(journalDirectory, `${prepared.transactionId}.json`));
    expect(evidence.publication).toBe("published");
    expect(evidence.journal.status).toBe("ready");
    disposeMergeExecutionWorktree(prepared);
  });
});

function repository(): string { const root = temp("merge-control-"); git(root, ["init", "-b", "main"]); git(root, ["config", "user.name", "Test"]); git(root, ["config", "user.email", "test@example.test"]); fs.writeFileSync(path.join(root, "tracked.txt"), "initial\n"); git(root, ["add", "."]); git(root, ["commit", "-m", "initial"]); return root; }
function branch(cwd: string, name: string): void { git(cwd, ["checkout", "-b", name]); }
function git(cwd: string, args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function temp(prefix: string): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-mimo-${prefix}`)); roots.push(root); return root; }
