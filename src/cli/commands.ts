import { execa } from "execa";
import { buildMimoRunArgs } from "../mimo/run-json.js";
import { implementPrompt, planPrompt, reviewPrompt } from "../core/prompt.js";

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

export async function runReview(cwd: string, diffSummary: string, files?: string[]): Promise<void> {
  const args = buildMimoRunArgs({
    cwd,
    agent: "plan",
    message: reviewPrompt(diffSummary),
    files
  });
  await execa("mimo", args, { cwd, ...commonOpts });
}
