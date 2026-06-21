import { execa } from "execa";
import { runImplement, runPlan, runReview } from "../cli/commands.js";
import {
  FixCiInput,
  HealthcheckInput,
  ImplementInput,
  PlanInput,
  ReviewInput,
  ResumeInput
} from "./tool-schemas.js";
import { buildMimoRunArgs } from "../mimo/run-json.js";
import { implementPrompt, planPrompt, reviewPrompt } from "../core/prompt.js";

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
  await runPlan(parsed.cwd, parsed.task);
  return {
    summary: "MiMoCode plan completed.",
    changedFiles: [],
    verification: []
  };
}

export async function mimoImplement(input: unknown) {
  const parsed = ImplementInput.parse(input);
  if (!parsed.allowWrite) {
    throw new Error("mimo_implement requires allowWrite=true.");
  }
  await runImplement(parsed.cwd, parsed.task);
  return {
    summary: "MiMoCode implementation completed. Codex should inspect git diff and run verification.",
    changedFiles: [],
    verification: []
  };
}

export async function mimoReview(input: unknown) {
  const parsed = ReviewInput.parse(input);
  const diffResult = await execa("git", ["diff", parsed.base], { cwd: parsed.cwd });
  await runReview(parsed.cwd, diffResult.stdout || "No changes found.");
  return {
    findings: [],
    summary: "Review completed."
  };
}

export async function mimoFixCi(input: unknown) {
  const parsed = FixCiInput.parse(input);
  const args = buildMimoRunArgs({
    cwd: parsed.cwd,
    agent: "build",
    message: implementPrompt(parsed.task ?? "Fix the CI failures shown in the attached log."),
    files: [parsed.file]
  });
  await execa("mimo", args, { cwd: parsed.cwd, stdout: "inherit", stderr: "inherit" });
  return {
    summary: "CI fix attempt completed. Codex should inspect git diff and run verification.",
    changedFiles: [],
    verification: []
  };
}

export async function mimoResume(input: unknown) {
  const parsed = ResumeInput.parse(input);
  const args = buildMimoRunArgs({
    cwd: parsed.cwd,
    agent: "build",
    message: parsed.task,
    session: parsed.session
  });
  await execa("mimo", args, { cwd: parsed.cwd, stdout: "inherit", stderr: "inherit" });
  return {
    summary: "Session resumed. Codex should inspect git diff and run verification.",
    changedFiles: [],
    verification: []
  };
}
