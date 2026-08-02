import { describe, expect, it, vi } from "vitest";

import {
  runDiffAcceptanceSelfCheck,
  type DiffCheckOptions
} from "../../../src/compose/acceptance.js";
import {
  runDeterministicDiffAcceptance,
  type DiffAcceptanceInput
} from "../../../src/compose/post-checks.js";
import type {
  GitCommitChangeSnapshot,
  GitDiffSnapshot,
  GitHeadSnapshot,
  GitStatusSnapshot
} from "../../../src/git/diff.js";

const cleanStatus: GitStatusSnapshot = { short: "", dirty: false, fingerprints: {} };
const cleanDiff: GitDiffSnapshot = { changedFiles: [], diffStat: "", diff: "" };
const head: GitHeadSnapshot = { oid: "abc", short: "abc", subject: "init" };
const emptyCommits: GitCommitChangeSnapshot = { commits: [], changedFiles: [] };

function makeOptions(overrides: Partial<DiffCheckOptions> = {}): DiffCheckOptions {
  return {
    cwd: "/tmp/project",
    captureStatus: vi.fn(async () => cleanStatus),
    captureDiff: vi.fn(async () => cleanDiff),
    captureHead: vi.fn(async () => head),
    captureCommitChanges: vi.fn(async () => emptyCommits),
    runDeterministic: vi.fn(async () => ({ stage: "diff_check" as const, outcome: "passed" as const })),
    ...overrides
  };
}

describe("runDiffAcceptanceSelfCheck", () => {
  it("passes when the workspace is clean and writes are allowed", async () => {
    const result = await runDiffAcceptanceSelfCheck(makeOptions());

    expect(result.outcome).toBe("passed");
    expect(result.summary).toBeUndefined();
  });

  it("fails with a summary when writes are not allowed and the workspace is dirty", async () => {
    const result = await runDiffAcceptanceSelfCheck(
      makeOptions({
        expectedWritesAllowed: false,
        captureStatus: vi.fn(async () => ({
          short: " M src/a.ts\n M README.md",
          dirty: true,
          fingerprints: {}
        })),
        captureDiff: vi.fn(async () => ({
          changedFiles: ["src/a.ts", "README.md"],
          diffStat: " src/a.ts | 4 +++-\n README.md | 1 +\n 2 files changed, 4 insertions(+), 1 deletion(-)",
          diff: "diff content"
        }))
      })
    );

    expect(result.outcome).toBe("failed");
    expect(result.summary).toEqual({
      changedFileCount: 2,
      samplePaths: ["src/a.ts", "README.md"],
      lineCounts: {
        "src/a.ts": 4,
        "README.md": 1
      }
    });
    expect(result.suggestion).toMatch(/Remove out-of-scope change src\/a\.ts/);
  });

  it("passes with a summary when writes are allowed and deterministic checks pass", async () => {
    const runDeterministic = vi.fn(async () => ({
      stage: "diff_check" as const,
      outcome: "passed" as const
    }));

    const result = await runDiffAcceptanceSelfCheck(
      makeOptions({
        expectedWritesAllowed: true,
        captureStatus: vi.fn(async () => ({
          short: " M src/a.ts",
          dirty: true,
          fingerprints: {}
        })),
        captureDiff: vi.fn(async () => ({
          changedFiles: ["src/a.ts"],
          diffStat: " src/a.ts | 10 +++++-----\n 1 file changed, 10 insertions(+), 5 deletions(-)",
          diff: "diff --git a/src/a.ts b/src/a.ts\n+change"
        })),
        runDeterministic
      })
    );

    expect(result.outcome).toBe("passed");
    expect(result.summary).toEqual({
      changedFileCount: 1,
      samplePaths: ["src/a.ts"],
      lineCounts: { "src/a.ts": 10 }
    });
    expect(runDeterministic).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/project",
        changedFiles: ["src/a.ts"],
        diffText: expect.stringContaining("src/a.ts")
      })
    );
  });

  it("runs the deterministic check for a clean merge workspace", async () => {
    const runDeterministic = vi.fn(async () => ({
      stage: "diff_check" as const,
      outcome: "passed" as const
    }));

    await runDiffAcceptanceSelfCheck(
      makeOptions({
        requireMergeTopology: true,
        gitHeadBefore: { oid: "before", short: "before", subject: "base" },
        captureHead: vi.fn(async () => ({ oid: "merge", short: "merge", subject: "merge" })),
        captureCommitChanges: vi.fn(async () => ({
          commits: ["merge merge"],
          commitOids: ["merge"],
          afterParentOids: ["before", "feature"],
          changedFiles: ["src/a.ts"]
        })),
        runDeterministic
      })
    );

    expect(runDeterministic).toHaveBeenCalledWith(expect.objectContaining({
      requireMergeTopology: true,
      changedFiles: []
    }));
  });

  it("uses attributed job changes instead of unrelated pre-existing HEAD changes", async () => {
    const runDeterministic = vi.fn(async () => ({
      stage: "diff_check" as const,
      outcome: "passed" as const
    }));

    await runDiffAcceptanceSelfCheck(
      makeOptions({
        changedFiles: ["src/a.ts"],
        allowedPaths: ["src/a.ts"],
        captureStatus: vi.fn(async () => ({
          short: " M src/a.ts\n M README.md",
          dirty: true,
          fingerprints: {}
        })),
        captureDiff: vi.fn(async () => ({
          changedFiles: ["src/a.ts", "README.md"],
          diffStat: " src/a.ts | 1 +\n README.md | 1 +",
          diff: "diff content"
        })),
        runDeterministic
      })
    );

    expect(runDeterministic).toHaveBeenCalledWith(expect.objectContaining({
      changedFiles: ["src/a.ts"],
      allowedPaths: ["src/a.ts"]
    }));
  });
});

describe("runDeterministicDiffAcceptance", () => {
  const passingCheck = vi.fn(async () => ({ passed: true }));

  function makeInput(overrides: Partial<DiffAcceptanceInput> = {}): DiffAcceptanceInput {
    return {
      cwd: "/tmp/project",
      changedFiles: [],
      runGitDiffCheck: passingCheck,
      ...overrides
    };
  }

  it("fails when git diff --check reports whitespace errors", async () => {
    const result = await runDeterministicDiffAcceptance(
      makeInput({
        runGitDiffCheck: vi.fn(async () => ({
          passed: false,
          reason: "src/a.ts:42: trailing whitespace."
        }))
      })
    );

    expect(result.outcome).toBe("failed");
    expect(result.command).toBe("git diff --check");
    expect(result.reason).toMatch(/trailing whitespace/);
  });

  it("fails when changed files are outside allowedPaths", async () => {
    const result = await runDeterministicDiffAcceptance(
      makeInput({
        changedFiles: ["src/a.ts", "README.md"],
        allowedPaths: ["src/"]
      })
    );

    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(/README\.md/);
    expect(result.suggestion).toBe(
      "Remove out-of-scope change README.md, then rerun the diff check."
    );
  });

  it("fails when unexpected commits appear", async () => {
    const result = await runDeterministicDiffAcceptance(
      makeInput({
        changedFiles: ["src/a.ts"],
        commitChanges: { commits: ["abc1234 WIP"], changedFiles: ["src/a.ts"] }
      })
    );

    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(/Unexpected commits/);
  });

  it("accepts only a complete non-fast-forward merge topology", async () => {
    const result = await runDeterministicDiffAcceptance(
      makeInput({
        changedFiles: ["src/a.ts"],
        allowedPaths: ["src/"],
        gitHeadBefore: { oid: "before", short: "before", subject: "base" },
        gitHeadAfter: { oid: "merge", short: "merge", subject: "merge feature" },
        commitChanges: {
          commits: ["merge merge feature"],
          commitOids: ["merge"],
          afterParentOids: ["before", "feature"],
          changedFiles: ["src/a.ts"]
        },
        forbidCommits: false,
        requireMergeTopology: true
      })
    );

    expect(result).toMatchObject({ stage: "diff_check", outcome: "passed" });
  });

  it("fails closed when a merge request fast-forwards", async () => {
    const result = await runDeterministicDiffAcceptance(
      makeInput({
        changedFiles: ["src/a.ts"],
        gitHeadBefore: { oid: "before", short: "before", subject: "base" },
        gitHeadAfter: { oid: "after", short: "after", subject: "feature" },
        commitChanges: {
          commits: ["after feature"],
          commitOids: ["after"],
          afterParentOids: ["before"],
          changedFiles: ["src/a.ts"]
        },
        forbidCommits: false,
        requireMergeTopology: true
      })
    );

    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(/non-fast-forward merge/);
  });

  it("checks committed merge files against allowedPaths independently", async () => {
    const result = await runDeterministicDiffAcceptance(
      makeInput({
        changedFiles: ["src/a.ts"],
        allowedPaths: ["src/"],
        gitHeadBefore: { oid: "before", short: "before", subject: "base" },
        gitHeadAfter: { oid: "merge", short: "merge", subject: "merge feature" },
        commitChanges: {
          commits: ["merge merge feature"],
          commitOids: ["merge"],
          afterParentOids: ["before", "feature"],
          changedFiles: ["src/a.ts", "README.md"]
        },
        forbidCommits: false,
        requireMergeTopology: true
      })
    );

    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(/Out-of-scope committed changes: README\.md/);
  });

  it("fails when conflict markers are present in the diff", async () => {
    const result = await runDeterministicDiffAcceptance(
      makeInput({
        changedFiles: ["src/a.ts"],
        diffText: "diff --git a/src/a.ts b/src/a.ts\n+<<<<<<< HEAD\n+>>>>>>> branch"
      })
    );

    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(/Conflict markers/);
    expect(result.suggestion).toMatch(/Resolve conflict markers in src\/a\.ts/);
  });

  it("fails when accidental generated artifacts are changed", async () => {
    const result = await runDeterministicDiffAcceptance(
      makeInput({
        changedFiles: ["dist/cli/main.js"]
      })
    );

    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(/Accidental generated artifacts/);
    expect(result.suggestion).toMatch(/Remove accidental artifact dist\/cli\/main\.js/);
  });
});
