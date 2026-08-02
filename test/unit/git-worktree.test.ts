import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disposeGitExecutionWorkspace,
  persistentWorktreePath,
  preparePersistentGitWorktree,
  reopenPersistentGitWorktree,
  prepareGitExecutionWorkspace
} from "../../src/git/worktree.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe("Git execution worktree", () => {
  it("uses the platform state directory when LOCALAPPDATA is unavailable", () => {
    const controlRoot = temporaryDirectory("portable-control-");
    const stateRoot = temporaryDirectory("portable-state-");
    vi.stubEnv("LOCALAPPDATA", "");
    vi.stubEnv("XDG_STATE_HOME", stateRoot);

    const resolved = persistentWorktreePath(controlRoot, "portable-job");
    expect(resolved.startsWith(path.join(stateRoot, "codex-mimo", "worktrees") + path.sep)).toBe(true);
    expect(path.basename(resolved)).toBe("portable-job");
  });

  it("overlays the complete control baseline without moving the control branch", () => {
    const controlRoot = createRepository();
    fs.writeFileSync(path.join(controlRoot, "dirty.txt"), "dirty worktree bytes\n");
    fs.writeFileSync(path.join(controlRoot, "staged.txt"), "staged index bytes\n");
    runGit(controlRoot, ["add", "staged.txt"]);
    fs.writeFileSync(path.join(controlRoot, "staged.txt"), "staged worktree bytes\n");
    fs.writeFileSync(path.join(controlRoot, "untracked.txt"), "untracked bytes\n");
    fs.writeFileSync(path.join(controlRoot, "ignored.log"), "ignored bytes\n");
    const controlHead = runGit(controlRoot, ["rev-parse", "HEAD"]);
    const controlBranch = runGit(controlRoot, ["branch", "--show-current"]);
    const executionRoot = path.join(temporaryDirectory("execution-parent-"), "execution");

    const prepared = prepareGitExecutionWorkspace(controlRoot, executionRoot);

    expect(fs.readFileSync(path.join(executionRoot, "dirty.txt"), "utf8")).toBe("dirty worktree bytes\n");
    expect(fs.readFileSync(path.join(executionRoot, "staged.txt"), "utf8")).toBe("staged worktree bytes\n");
    expect(fs.readFileSync(path.join(executionRoot, "untracked.txt"), "utf8")).toBe("untracked bytes\n");
    expect(fs.readFileSync(path.join(executionRoot, "ignored.log"), "utf8")).toBe("ignored bytes\n");
    expect(fs.existsSync(path.join(executionRoot, ".codex-mimo"))).toBe(false);
    expect(runGit(executionRoot, ["status", "--porcelain"])).toContain(" M dirty.txt");
    expect(runGit(executionRoot, ["status", "--porcelain"])).toContain("MM staged.txt");
    expect(runGit(executionRoot, ["show", ":staged.txt"])).toBe("staged index bytes");
    expect(runGit(executionRoot, ["status", "--porcelain"])).toContain("?? untracked.txt");

    fs.writeFileSync(path.join(executionRoot, "committed-from-execution.txt"), "isolated commit\n");
    runGit(executionRoot, ["add", "-A"]);
    runGit(executionRoot, ["commit", "-m", "execution change"]);
    expect(runGit(controlRoot, ["rev-parse", "HEAD"])).toBe(controlHead);
    expect(runGit(controlRoot, ["branch", "--show-current"])).toBe(controlBranch);
    expect(fs.existsSync(path.join(controlRoot, "committed-from-execution.txt"))).toBe(false);

    disposeGitExecutionWorkspace(prepared);
    expect(fs.existsSync(executionRoot)).toBe(false);
    expect(runGit(controlRoot, ["rev-parse", "HEAD"])).toBe(controlHead);
  });

  it("rejects an existing, control, or unowned execution root without removing it", () => {
    const controlRoot = createRepository();
    const existingRoot = temporaryDirectory("existing-");
    const retainedFile = path.join(existingRoot, "keep.txt");
    fs.writeFileSync(retainedFile, "keep");

    expect(() => prepareGitExecutionWorkspace(controlRoot, controlRoot)).toThrow("distinct sibling or external directory");
    expect(() => prepareGitExecutionWorkspace(controlRoot, existingRoot)).toThrow("already exists");
    expect(fs.readFileSync(retainedFile, "utf8")).toBe("keep");
  });

  it("rejects a control symlink that would expose files outside the worktree", () => {
    const controlRoot = createRepository();
    const outsideRoot = temporaryDirectory("outside-");
    fs.writeFileSync(path.join(outsideRoot, "secret.txt"), "outside");
    fs.symlinkSync(outsideRoot, path.join(controlRoot, "outside-link"), process.platform === "win32" ? "junction" : "dir");
    const executionRoot = path.join(temporaryDirectory("execution-parent-"), "execution");

    expect(() => prepareGitExecutionWorkspace(controlRoot, executionRoot))
      .toThrow("Workspace symlink escapes source root: outside-link");
    expect(fs.existsSync(executionRoot)).toBe(false);
  });

  it("requires matching owner metadata before disposing a worktree", () => {
    const controlRoot = createRepository();
    const executionRoot = path.join(temporaryDirectory("execution-parent-"), "execution");
    const prepared = prepareGitExecutionWorkspace(controlRoot, executionRoot);

    expect(() => disposeGitExecutionWorkspace({ ...prepared, ownerToken: "not-the-owner" }))
      .toThrow("owner metadata");
    expect(fs.existsSync(executionRoot)).toBe(true);

    disposeGitExecutionWorkspace(prepared);
    expect(fs.existsSync(executionRoot)).toBe(false);
  });

  it("creates and reopens a named persistent worktree without moving control HEAD", () => {
    const controlRoot = createRepository();
    fs.writeFileSync(path.join(controlRoot, "dirty.txt"), "user dirty\n");
    const base = temporaryDirectory("persistent-base-");
    const before = runGit(controlRoot, ["rev-parse", "HEAD"]);
    const prepared = preparePersistentGitWorktree(controlRoot, "worktree-job", { base });

    expect(prepared.branch).toBe("codex-mimo/worktree/worktree-job");
    expect(prepared.executionRoot).toContain(path.join("codex-mimo", "worktrees"));
    expect(fs.readFileSync(path.join(prepared.executionRoot, "dirty.txt"), "utf8")).toBe("user dirty\n");
    expect(runGit(prepared.executionRoot, ["branch", "--show-current"])).toBe(prepared.branch);
    expect(reopenPersistentGitWorktree(prepared).executionRoot).toBe(prepared.executionRoot);
    expect(runGit(controlRoot, ["rev-parse", "HEAD"])).toBe(before);
    expect(() => reopenPersistentGitWorktree({ ...prepared, ownerToken: "forged" })).toThrow("lease");
    expect(() => reopenPersistentGitWorktree({ ...prepared, jobId: "forged-job" })).toThrow("lease");
    expect(() => reopenPersistentGitWorktree({ ...prepared, branch: "codex-mimo/worktree/forged" })).toThrow("lease");
    expect(() => reopenPersistentGitWorktree({ ...prepared, createdAt: "2020-01-01T00:00:00.000Z" })).toThrow("lease");

    const ownerMetadata = fs.readFileSync(prepared.ownerMetadataPath, "utf8");
    fs.writeFileSync(prepared.ownerMetadataPath, ownerMetadata.replace('"version":1', '"version":2'), "utf8");
    expect(() => reopenPersistentGitWorktree(prepared)).toThrow("lease");
    fs.writeFileSync(prepared.ownerMetadataPath, ownerMetadata, "utf8");

    disposeGitExecutionWorkspace(prepared);
  });

  it("rejects and removes an execution worktree when the control baseline changes during preparation", () => {
    const controlRoot = createRepository();
    const executionRoot = path.join(temporaryDirectory("execution-parent-"), "execution");

    expect(() => prepareGitExecutionWorkspace(controlRoot, executionRoot, {
      onBeforeBaselineVerification: () => {
        fs.writeFileSync(path.join(controlRoot, "dirty.txt"), "user edit during preparation\n");
        fs.writeFileSync(path.join(controlRoot, "tracked.txt"), "staged edit during preparation\n");
        runGit(controlRoot, ["add", "tracked.txt"]);
      }
    })).toThrow("Workspace changed during preparation.");

    expect(fs.existsSync(executionRoot)).toBe(false);
    expect(fs.readFileSync(path.join(controlRoot, "dirty.txt"), "utf8")).toBe("user edit during preparation\n");
    expect(runGit(controlRoot, ["show", ":tracked.txt"])).toBe("staged edit during preparation");
  });
});

function createRepository(): string {
  const root = temporaryDirectory("control-");
  runGit(root, ["init"]);
  runGit(root, ["config", "user.email", "test@example.com"]);
  runGit(root, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(root, ".gitignore"), "*.log\n.codex-mimo/\n");
  fs.writeFileSync(path.join(root, "dirty.txt"), "initial dirty\n");
  fs.writeFileSync(path.join(root, "staged.txt"), "initial staged\n");
  fs.writeFileSync(path.join(root, "tracked.txt"), "initial\n");
  fs.mkdirSync(path.join(root, ".codex-mimo"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex-mimo", "runtime.json"), "runtime");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "initial"]);
  return root;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function temporaryDirectory(prefix: string): string {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `codex-mimo-${prefix}`));
  temporaryRoots.push(temporaryRoot);
  return temporaryRoot;
}
