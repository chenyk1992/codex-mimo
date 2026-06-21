#!/usr/bin/env node
import { runImplement, runPlan, runReview } from "./commands.js";
import { execa } from "execa";
import { SessionStore } from "../core/sessions.js";

const [, , command, ...rest] = process.argv;
const cwd = process.cwd();

function extractFlag(flag: string): string | undefined {
  const idx = rest.indexOf(flag);
  if (idx === -1 || idx + 1 >= rest.length) return undefined;
  const value = rest[idx + 1];
  rest.splice(idx, 2);
  return value;
}

function hasFlag(flag: string): boolean {
  const idx = rest.indexOf(flag);
  if (idx === -1) return false;
  rest.splice(idx, 1);
  return true;
}

const sessionFlag = extractFlag("--session");
const fileFlag = extractFlag("--file");
const dryRun = hasFlag("--dry-run");
const jsonOutput = hasFlag("--json");
const ciMode = hasFlag("--ci");

const task = rest.join(" ").trim();

if (!command) {
  console.error("Usage: codex-mimo <plan|implement|review|healthcheck|sessions|resume> [task]");
  process.exit(2);
}

if (command === "healthcheck") {
  try {
    const result = await execa("mimo", ["--version"], { cwd });
    console.log(JSON.stringify({ ok: true, version: result.stdout.trim() }));
  } catch {
    console.log(JSON.stringify({ ok: false, error: "mimo not found or not working" }));
    process.exit(1);
  }
} else if (command === "plan") {
  if (!task) { console.error("Usage: codex-mimo plan <task>"); process.exit(2); }
  await runPlan(cwd, task);
} else if (command === "implement") {
  if (!task) { console.error("Usage: codex-mimo implement <task>"); process.exit(2); }
  await runImplement(cwd, task);
} else if (command === "review") {
  const diffResult = await execa("git", ["diff", "HEAD"], { cwd });
  await runReview(cwd, diffResult.stdout || "No changes found.");
} else if (command === "sessions") {
  const store = new SessionStore(cwd);
  const sessions = store.list();
  if (sessions.length === 0) {
    console.log("No sessions found.");
  } else {
    console.log(JSON.stringify(sessions, null, 2));
  }
} else if (command === "resume") {
  if (!sessionFlag) { console.error("Usage: codex-mimo resume --session <id> <task>"); process.exit(2); }
  const store = new SessionStore(cwd);
  const entry = store.get(sessionFlag);
  if (!entry) { console.error(`Session not found: ${sessionFlag}`); process.exit(1); }
  const args = ["run", "--format", "json", "--agent", "build", "--session", sessionFlag];
  if (task) args.push(task);
  else args.push("Continue the previous task.");
  await execa("mimo", args, { cwd, stdout: "inherit", stderr: "inherit" });
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(2);
}
