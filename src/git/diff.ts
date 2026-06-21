import { execa } from "execa";

export interface DiffResult {
  stat: string;
  diff: string;
  changedFiles: string[];
  hasChanges: boolean;
}

export async function captureDiff(cwd: string, base: string = "HEAD"): Promise<DiffResult> {
  const [statResult, diffResult, nameResult] = await Promise.all([
    execa("git", ["diff", "--stat", base], { cwd, reject: false }),
    execa("git", ["diff", base], { cwd, reject: false }),
    execa("git", ["diff", "--name-only", base], { cwd, reject: false })
  ]);

  const changedFiles = nameResult.stdout
    ? nameResult.stdout.split("\n").filter((f) => f.trim())
    : [];

  return {
    stat: statResult.stdout ?? "",
    diff: diffResult.stdout ?? "",
    changedFiles,
    hasChanges: changedFiles.length > 0
  };
}

export async function captureStatus(cwd: string): Promise<string> {
  const result = await execa("git", ["status", "--short"], { cwd, reject: false });
  return result.stdout ?? "";
}
