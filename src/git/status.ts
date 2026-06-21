import { execa } from "execa";

export interface WorktreeStatus {
  branch: string;
  clean: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
}

export interface GitStatusSnapshot {
  short: string;
  dirty: boolean;
}

export async function captureGitStatus(cwd: string): Promise<GitStatusSnapshot> {
  const result = await execa("git", ["status", "--short"], { cwd, reject: false });
  return {
    short: result.stdout ?? "",
    dirty: (result.stdout ?? "").trim().length > 0
  };
}

export async function captureWorktreeStatus(cwd: string): Promise<WorktreeStatus> {
  const [branchResult, statusResult] = await Promise.all([
    execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, reject: false }),
    execa("git", ["status", "--porcelain"], { cwd, reject: false })
  ]);

  const branch = branchResult.stdout?.trim() ?? "unknown";
  const lines = statusResult.stdout
    ? statusResult.stdout.split("\n").filter((l) => l.trim())
    : [];

  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    const indexStatus = line[0];
    const worktreeStatus = line[1];
    const file = line.slice(3);

    if (indexStatus === "?") {
      untracked.push(file);
    } else {
      if (indexStatus !== " " && indexStatus !== "?") staged.push(file);
      if (worktreeStatus !== " " && worktreeStatus !== "?") modified.push(file);
    }
  }

  return {
    branch,
    clean: lines.length === 0,
    staged,
    modified,
    untracked
  };
}
