#!/usr/bin/env node
import { runFixCi, runImplement, runPlan, runReview } from "./commands.js";
import { runComposeWorkflow } from "../compose/runner.js";
import { composeWorkflowUsage } from "../compose/workflow-names.js";
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

function extractRepeatedFlag(flag: string): string[] {
  const values: string[] = [];
  let idx = rest.indexOf(flag);
  while (idx !== -1 && idx + 1 < rest.length) {
    values.push(rest[idx + 1]);
    rest.splice(idx, 2);
    idx = rest.indexOf(flag);
  }
  return values;
}

function hasFlag(flag: string): boolean {
  const idx = rest.indexOf(flag);
  if (idx === -1) return false;
  rest.splice(idx, 1);
  return true;
}

const sessionFlag = extractFlag("--session");
const fileFlag = extractFlag("--file");
const baseFlag = extractFlag("--since");
const dryRun = hasFlag("--dry-run");
const jsonOutput = hasFlag("--json");
const ciMode = hasFlag("--ci");

// Extract compose-specific flags before building task
const workflowFlag = command === "compose" ? extractFlag("--workflow") : undefined;
const modelFlag = command === "compose" ? extractFlag("--model") : undefined;
const attachFlag = command === "compose" ? extractFlag("--attach") : undefined;
const reportDirFlag = command === "compose" ? extractFlag("--report-dir") : undefined;
const timeoutMsFlag = command === "compose" ? extractFlag("--timeout-ms") : undefined;
const verifyCommands = command === "compose" ? extractRepeatedFlag("--verify") : [];
const forkFlag = command === "compose" ? hasFlag("--fork") : false;
const continueFlag = command === "compose" ? hasFlag("--continue") : false;

const task = rest.join(" ").trim();
const timeoutMs = timeoutMsFlag ? Number(timeoutMsFlag) : undefined;

if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
  console.error("--timeout-ms must be a positive integer.");
  process.exit(2);
}

if (!command) {
  console.error("Usage: codex-mimo <plan|implement|review|fix-ci|compose|healthcheck|sessions|resume> [task]");
  process.exit(2);
}

const extraFiles = fileFlag ? [fileFlag] : [];

if (command === "healthcheck") {
  try {
    const result = await execa("mimo", ["--version"], { cwd });
    const output = { ok: true, version: result.stdout.trim() };
    console.log(JSON.stringify(output));
  } catch {
    console.log(JSON.stringify({ ok: false, error: "mimo not found or not working" }));
    process.exit(1);
  }
} else if (command === "plan") {
  if (!task) { console.error("Usage: codex-mimo plan <task>"); process.exit(2); }
  if (dryRun) {
    console.log(`[dry-run] codex-mimo plan "${task}"`);
    process.exit(0);
  }
  await runPlan(cwd, task, extraFiles);
} else if (command === "implement") {
  if (!task) { console.error("Usage: codex-mimo implement <task>"); process.exit(2); }
  if (dryRun) {
    console.log(`[dry-run] codex-mimo implement "${task}"`);
    process.exit(0);
  }
  await runImplement(cwd, task, extraFiles, ciMode);
} else if (command === "review") {
  if (dryRun) {
    console.log("[dry-run] codex-mimo review");
    process.exit(0);
  }
  await runReview(cwd, baseFlag ?? "HEAD", extraFiles);
} else if (command === "fix-ci") {
  if (!fileFlag) { console.error("Usage: codex-mimo fix-ci --file <ci.log> [task]"); process.exit(2); }
  if (dryRun) {
    console.log(`[dry-run] codex-mimo fix-ci --file ${fileFlag} "${task}"`);
    process.exit(0);
  }
  await runFixCi(cwd, fileFlag, task || undefined, extraFiles);
} else if (command === "compose") {
  if (!workflowFlag) {
    console.error(`Usage: codex-mimo compose --workflow <${composeWorkflowUsage()}> [task]`);
    process.exit(2);
  }

  const result = await runComposeWorkflow({
    cwd,
    workflow: workflowFlag as any,
    task: task || undefined,
    file: fileFlag,
    since: baseFlag,
    model: modelFlag,
    attach: attachFlag,
    session: sessionFlag,
    fork: forkFlag,
    continue: continueFlag,
    verification: verifyCommands.length > 0 ? verifyCommands : undefined,
    dryRun,
    reportDir: reportDirFlag,
    timeoutMs
  });

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Workflow: ${result.workflow}`);
    console.log(`Status: ${result.status}`);
    console.log(`Changed files: ${result.changedFiles.length}`);
    if (result.changedFiles.length > 0) {
      for (const file of result.changedFiles) {
        console.log(`  - ${file}`);
      }
    }
    if (result.verification.length > 0) {
      console.log("Verification:");
      for (const v of result.verification) {
        console.log(`  ${v.passed ? "PASS" : "FAIL"} ${v.command} exit=${v.exitCode}`);
      }
    }
    console.log(`Report: ${result.reportPaths.markdown}`);
  }
} else if (command === "sessions") {
  const store = new SessionStore(cwd);
  const sessions = store.list();
  const output = sessions.length === 0 ? { sessions: [], message: "No sessions found." } : { sessions };
  console.log(JSON.stringify(output, null, 2));
} else if (command === "resume") {
  if (!sessionFlag) { console.error("Usage: codex-mimo resume --session <id> <task>"); process.exit(2); }
  if (dryRun) {
    console.log(`[dry-run] codex-mimo resume --session ${sessionFlag} "${task}"`);
    process.exit(0);
  }
  const store = new SessionStore(cwd);
  const entry = store.get(sessionFlag);
  if (!entry) { console.error(`Session not found: ${sessionFlag}`); process.exit(1); }
  const args = ["run", "--format", "json", "--agent", "build", "--session", sessionFlag];
  if (task) args.push(task);
  else args.push("Continue the previous task.");
  await execa("mimo", args, { cwd, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(2);
}
