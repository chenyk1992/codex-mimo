import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureGitStatus } from "../../src/git/diff.js";
import { detectReadOnlyViolationFiles } from "../../src/compose/post-checks.js";

const roots: string[] = [];

function repo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-status-snapshot-"));
  roots.push(cwd);
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd });
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "base\n", "utf-8");
  execFileSync("git", ["add", "tracked.txt"], { cwd });
  execFileSync("git", ["commit", "-m", "initial"], { cwd, stdio: "ignore" });
  return cwd;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workspace dirty content snapshots", () => {
  it("does not flag unchanged pre-existing tracked and untracked dirty files", async () => {
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "dirty-before\n", "utf-8");
    fs.writeFileSync(path.join(cwd, "untracked.txt"), "untracked-before\n", "utf-8");
    const before = await captureGitStatus(cwd);
    const after = await captureGitStatus(cwd);

    expect(detectReadOnlyViolationFiles(false, ["tracked.txt"], before, after)).toEqual([]);
  });

  it.each([
    ["tracked.txt", "dirty-before\n", "dirty-after\n"],
    ["untracked.txt", "untracked-before\n", "untracked-after\n"]
  ])("detects further content changes to pre-existing dirty %s", async (file, beforeText, afterText) => {
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, file), beforeText, "utf-8");
    const before = await captureGitStatus(cwd);
    fs.writeFileSync(path.join(cwd, file), afterText, "utf-8");
    const after = await captureGitStatus(cwd);

    expect(detectReadOnlyViolationFiles(false, [file], before, after)).toContain(file);
  });

  it("detects staged content changes even when the status code remains staged", async () => {
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "staged-before\n", "utf-8");
    execFileSync("git", ["add", "tracked.txt"], { cwd });
    const before = await captureGitStatus(cwd);
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "staged-after\n", "utf-8");
    execFileSync("git", ["add", "tracked.txt"], { cwd });
    const after = await captureGitStatus(cwd);

    expect(detectReadOnlyViolationFiles(false, ["tracked.txt"], before, after)).toEqual(["tracked.txt"]);
  });

  it("detects additions, deletions, and renames from status fingerprints", async () => {
    const cwd = repo();
    const before = await captureGitStatus(cwd);
    fs.writeFileSync(path.join(cwd, "added.txt"), "new\n", "utf-8");
    fs.unlinkSync(path.join(cwd, "tracked.txt"));
    const afterDeleteAdd = await captureGitStatus(cwd);
    expect(detectReadOnlyViolationFiles(false, [], before, afterDeleteAdd).sort())
      .toEqual(["added.txt", "tracked.txt"]);

    fs.unlinkSync(path.join(cwd, "added.txt"));
    execFileSync("git", ["restore", "tracked.txt"], { cwd });
    execFileSync("git", ["mv", "tracked.txt", "renamed.txt"], { cwd });
    const afterRename = await captureGitStatus(cwd);
    expect(detectReadOnlyViolationFiles(false, [], before, afterRename).sort())
      .toEqual(["renamed.txt", "tracked.txt"]);
  });
});
