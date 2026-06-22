import { execa } from "execa";

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
