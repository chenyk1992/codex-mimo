import { beforeEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import {
  captureGitCommitChanges,
  captureGitDiff,
  captureGitHead,
  captureGitStatus,
  parseChangedFiles
} from "../../src/git/diff.js";

vi.mock("execa", () => ({
  execa: vi.fn()
}));

const mockedExeca = vi.mocked(execa);

describe("git diff helpers", () => {
  beforeEach(() => {
    mockedExeca.mockReset();
  });

  it("parses changed files from git diff --name-only output", () => {
    expect(parseChangedFiles("src/a.ts\nREADME.md\n\n")).toEqual(["src/a.ts", "README.md"]);
  });

  it("returns an empty list for blank output", () => {
    expect(parseChangedFiles("\n")).toEqual([]);
  });

  it("captures git status with the cwd trusted for this command", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: " M src/a.ts\n",
      stderr: ""
    });

    await expect(captureGitStatus("E:/repo")).resolves.toEqual({
      short: " M src/a.ts\n",
      dirty: true
    });
    expect(mockedExeca).toHaveBeenCalledWith(
      "git",
      ["-c", "safe.directory=E:/repo", "status", "--short"],
      { cwd: "E:/repo", reject: false }
    );
  });

  it("throws when git status exits non-zero", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: detected dubious ownership in repository"
    });

    await expect(captureGitStatus("E:/repo")).rejects.toThrow(
      "Git status capture failed: fatal: detected dubious ownership in repository"
    );
  });

  it("captures git diff with the cwd trusted for each git command", async () => {
    mockedExeca
      .mockResolvedValueOnce({ stdout: "src/a.ts\n", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: " src/a.ts | 1 +", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "diff --git a/src/a.ts b/src/a.ts", stderr: "", exitCode: 0 });

    await expect(captureGitDiff("E:/repo", "HEAD~1")).resolves.toEqual({
      changedFiles: ["src/a.ts"],
      diffStat: " src/a.ts | 1 +",
      diff: "diff --git a/src/a.ts b/src/a.ts"
    });
    expect(mockedExeca).toHaveBeenNthCalledWith(
      1,
      "git",
      ["-c", "safe.directory=E:/repo", "diff", "--name-only", "HEAD~1"],
      { cwd: "E:/repo" }
    );
    expect(mockedExeca).toHaveBeenNthCalledWith(
      2,
      "git",
      ["-c", "safe.directory=E:/repo", "diff", "--stat", "HEAD~1"],
      { cwd: "E:/repo" }
    );
    expect(mockedExeca).toHaveBeenNthCalledWith(
      3,
      "git",
      ["-c", "safe.directory=E:/repo", "diff", "HEAD~1"],
      { cwd: "E:/repo" }
    );
  });

  it("captures the current git HEAD with the cwd trusted", async () => {
    mockedExeca
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "2662087b0a2ad3d0b5e1d9e3a98a4f7412d6beef",
        stderr: ""
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "2662087 chore: seed vibe demo",
        stderr: ""
      });

    await expect(captureGitHead("E:/repo")).resolves.toEqual({
      oid: "2662087b0a2ad3d0b5e1d9e3a98a4f7412d6beef",
      short: "2662087",
      subject: "chore: seed vibe demo"
    });
    expect(mockedExeca).toHaveBeenNthCalledWith(
      1,
      "git",
      ["-c", "safe.directory=E:/repo", "rev-parse", "--verify", "HEAD"],
      { cwd: "E:/repo", reject: false }
    );
    expect(mockedExeca).toHaveBeenNthCalledWith(
      2,
      "git",
      ["-c", "safe.directory=E:/repo", "log", "-1", "--format=%h %s"],
      { cwd: "E:/repo" }
    );
  });

  it("captures commits and files between two git heads", async () => {
    mockedExeca
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "7770acb test: add discount code test cases\n1672c89 feat: add discount code support",
        stderr: ""
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "src/pricing.js\ntest/pricing.test.js",
        stderr: ""
      });

    await expect(
      captureGitCommitChanges(
        "E:/repo",
        { oid: "2662087", short: "2662087", subject: "seed" },
        { oid: "1672c89", short: "1672c89", subject: "feat" }
      )
    ).resolves.toEqual({
      commits: [
        "7770acb test: add discount code test cases",
        "1672c89 feat: add discount code support"
      ],
      changedFiles: ["src/pricing.js", "test/pricing.test.js"]
    });
    expect(mockedExeca).toHaveBeenNthCalledWith(
      1,
      "git",
      ["-c", "safe.directory=E:/repo", "log", "--oneline", "--reverse", "2662087..1672c89"],
      { cwd: "E:/repo" }
    );
    expect(mockedExeca).toHaveBeenNthCalledWith(
      2,
      "git",
      ["-c", "safe.directory=E:/repo", "diff", "--name-only", "2662087", "1672c89"],
      { cwd: "E:/repo" }
    );
  });
});
