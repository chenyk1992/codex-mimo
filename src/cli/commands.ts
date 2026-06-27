import { implementPrompt, planPrompt, reviewPrompt } from "../core/prompt.js";
import { captureGitDiff } from "../git/diff.js";
import { runAndCapture, type MimoRunResult } from "../mimo/mimo-runner.js";

export function formatMimoRunResult(command: string, result: MimoRunResult): string {
  const lines = [
    `Command: ${command}`,
    `Status: ${result.exitCode === 0 ? "completed" : "failed"}`,
    `Session: ${result.sessionId ?? "unknown"}`,
    `Summary: ${result.summary || "Completed."}`
  ];

  if (result.changedFiles.length > 0) {
    lines.push("Changed files:");
    for (const file of result.changedFiles) lines.push(`  - ${file}`);
  }

  if (result.commands.length > 0) {
    lines.push("Commands:");
    for (const commandResult of result.commands) {
      lines.push(`  - ${commandResult.command} exit=${commandResult.exitCode ?? "unknown"}`);
    }
  }

  if (result.errors.length > 0) {
    lines.push("Errors:");
    for (const error of result.errors) lines.push(`  - ${error}`);
  }

  return lines.join("\n");
}

export function composeStatusExitCode(status: string): number {
  return status === "failed" || status === "timeout" ? 1 : 0;
}

export async function runPlan(cwd: string, task: string, files?: string[]): Promise<MimoRunResult> {
  const message = planPrompt(task);
  return runAndCapture({
    cwd,
    agent: "plan",
    message,
    files: files ?? []
  });
}

export async function runImplement(cwd: string, task: string, files?: string[], ciMode?: boolean): Promise<MimoRunResult> {
  const message = implementPrompt(task);
  return runAndCapture({
    cwd,
    agent: "build",
    message,
    files: files ?? []
  });
}

export async function runReview(cwd: string, base?: string, files?: string[]): Promise<MimoRunResult> {
  const diff = await captureGitDiff(cwd, base ?? "HEAD");
  const hasChanges = diff.changedFiles.length > 0;
  const diffSummary = hasChanges
    ? `Changed files:\n${diff.changedFiles.join("\n")}\n\nDiff:\n${diff.diff}`
    : "No changes found.";
  const message = reviewPrompt(diffSummary);
  return runAndCapture({
    cwd,
    agent: "plan",
    message,
    files: files ?? []
  });
}

export async function runFixCi(cwd: string, file: string, task?: string, files?: string[]): Promise<MimoRunResult> {
  const message = implementPrompt(task ?? "Fix the CI failures shown in the attached log.");
  return runAndCapture({
    cwd,
    agent: "build",
    message,
    files: [file, ...(files ?? [])]
  });
}

export async function runResume(cwd: string, session: string, task?: string, files?: string[]): Promise<MimoRunResult> {
  const message = implementPrompt(task || "Continue the previous task.");
  return runAndCapture({
    cwd,
    agent: "build",
    session,
    message,
    files: files ?? []
  });
}
