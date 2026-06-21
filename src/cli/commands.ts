import { execa } from "execa";
import { buildMimoRunArgs } from "../mimo/run-json.js";
import { implementPrompt, planPrompt, reviewPrompt } from "../core/prompt.js";
import { captureDiff } from "../git/diff.js";

const commonOpts = { stdin: "ignore" as const, stdout: "inherit" as const, stderr: "inherit" as const };

export async function runPlan(cwd: string, task: string, files?: string[]): Promise<void> {
  const args = buildMimoRunArgs({
    cwd,
    agent: "plan",
    message: planPrompt(task),
    files
  });
  await execa("mimo", args, { cwd, ...commonOpts });
}

export async function runImplement(cwd: string, task: string, files?: string[], ciMode?: boolean): Promise<void> {
  const args = buildMimoRunArgs({
    cwd,
    agent: "build",
    message: implementPrompt(task),
    files
  });
  await execa("mimo", args, { cwd, ...commonOpts });
}

export async function runReview(cwd: string, base?: string, files?: string[]): Promise<void> {
  const diff = await captureDiff(cwd, base ?? "HEAD");
  const diffSummary = diff.hasChanges
    ? `Changed files:\n${diff.changedFiles.join("\n")}\n\nDiff:\n${diff.diff}`
    : "No changes found.";
  const args = buildMimoRunArgs({
    cwd,
    agent: "plan",
    message: reviewPrompt(diffSummary),
    files
  });
  await execa("mimo", args, { cwd, ...commonOpts });
}

export async function runFixCi(cwd: string, file: string, task?: string, files?: string[]): Promise<void> {
  const args = buildMimoRunArgs({
    cwd,
    agent: "build",
    message: implementPrompt(task ?? "Fix the CI failures shown in the attached log."),
    files: [file, ...(files ?? [])]
  });
  await execa("mimo", args, { cwd, ...commonOpts });
}
