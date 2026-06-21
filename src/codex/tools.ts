import { execa } from "execa";
import {
  ComposeInput,
  FixCiInput,
  HealthcheckInput,
  ImplementInput,
  PlanInput,
  ReviewInput,
  ResumeInput
} from "./tool-schemas.js";
import { implementPrompt, planPrompt, reviewPrompt } from "../core/prompt.js";
import { runAndCapture } from "../mimo/mimo-runner.js";
import { runComposeWorkflow } from "../compose/runner.js";

export async function mimoHealthcheck(input: unknown) {
  const parsed = HealthcheckInput.parse(input);
  const cwd = parsed.cwd ?? process.cwd();
  try {
    const result = await execa("mimo", ["--version"], { cwd });
    return {
      ok: true,
      version: result.stdout.trim(),
      cwd
    };
  } catch {
    return { ok: false, error: "mimo not found or not working", cwd };
  }
}

export async function mimoPlan(input: unknown) {
  const parsed = PlanInput.parse(input);
  const result = await runAndCapture({
    cwd: parsed.cwd,
    agent: parsed.agent,
    model: parsed.model,
    message: planPrompt(parsed.task)
  });
  return {
    summary: result.summary,
    sessionId: result.sessionId,
    changedFiles: result.changedFiles,
    verification: result.commands
  };
}

export async function mimoImplement(input: unknown) {
  const parsed = ImplementInput.parse(input);
  if (!parsed.allowWrite) {
    throw new Error("mimo_implement requires allowWrite=true.");
  }
  const result = await runAndCapture({
    cwd: parsed.cwd,
    agent: "build",
    message: implementPrompt(parsed.task)
  });
  return {
    summary: result.summary,
    sessionId: result.sessionId,
    changedFiles: result.changedFiles,
    commands: result.commands,
    risks: result.errors
  };
}

export async function mimoReview(input: unknown) {
  const parsed = ReviewInput.parse(input);
  const diffResult = await execa("git", ["diff", parsed.base], { cwd: parsed.cwd });
  const result = await runAndCapture({
    cwd: parsed.cwd,
    agent: "plan",
    message: reviewPrompt(diffResult.stdout || "No changes found.")
  });
  
  // Return findings based on review content
  const findings = result.summary && result.summary !== "Completed."
    ? [{ severity: "info", title: "Review Summary", body: result.summary }]
    : [];

  return {
    summary: result.summary,
    sessionId: result.sessionId,
    findings
  };
}

export async function mimoFixCi(input: unknown) {
  const parsed = FixCiInput.parse(input);
  const result = await runAndCapture({
    cwd: parsed.cwd,
    agent: "build",
    message: implementPrompt(parsed.task ?? "Fix the CI failures shown in the attached log."),
    files: [parsed.file]
  });
  return {
    summary: result.summary,
    sessionId: result.sessionId,
    changedFiles: result.changedFiles,
    commands: result.commands,
    risks: result.errors
  };
}

export async function mimoResume(input: unknown) {
  const parsed = ResumeInput.parse(input);
  const result = await runAndCapture({
    cwd: parsed.cwd,
    agent: "build",
    message: parsed.task,
    session: parsed.session
  });
  return {
    summary: result.summary,
    sessionId: result.sessionId,
    changedFiles: result.changedFiles,
    commands: result.commands,
    risks: result.errors
  };
}

export async function mimoCompose(input: unknown) {
  const parsed = ComposeInput.parse(input);
  return await runComposeWorkflow(parsed);
}
