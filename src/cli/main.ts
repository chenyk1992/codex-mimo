#!/usr/bin/env node
import { composeStatusExitCode, formatMimoRunResult, runFixCi, runImplement, runPlan, runResume, runReview } from "./commands.js";
import { runComposeWorkflow } from "../compose/runner.js";
import { runComposeJobWorker } from "../compose/job-worker.js";
import { composeWorkflowUsage } from "../compose/workflow.js";
import { execa } from "execa";
import { SessionStore } from "../core/sessions.js";
import { resolveMimoCommand } from "../mimo/run-json.js";

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
const cwdFlag = extractFlag("--cwd");
const effectiveCwd = cwdFlag ?? cwd;
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
const timeoutMs = timeoutMsFlag ? Number(timeoutMsFlag) : 1_800_000;

if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
  console.error("--timeout-ms must be a positive integer.");
  process.exit(2);
}

if (!command) {
  console.error("Usage: codex-mimo <plan|implement|review|fix-ci|compose|healthcheck|sessions|resume> [task]");
  process.exit(2);
}

const extraFiles = fileFlag ? [fileFlag] : [];

function printDirectResult(command: string, result: Awaited<ReturnType<typeof runPlan>>): void {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatMimoRunResult(command, result));
  }
  if (result.exitCode !== 0) process.exit(1);
}

if (command === "healthcheck") {
  try {
    const result = await execa(resolveMimoCommand(), ["--version"], { cwd: effectiveCwd });
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
  printDirectResult("plan", await runPlan(effectiveCwd, task, extraFiles));
} else if (command === "implement") {
  if (!task) { console.error("Usage: codex-mimo implement <task>"); process.exit(2); }
  if (dryRun) {
    console.log(`[dry-run] codex-mimo implement "${task}"`);
    process.exit(0);
  }
  printDirectResult("implement", await runImplement(effectiveCwd, task, extraFiles, ciMode));
} else if (command === "review") {
  if (dryRun) {
    console.log("[dry-run] codex-mimo review");
    process.exit(0);
  }
  printDirectResult("review", await runReview(effectiveCwd, baseFlag ?? "HEAD", extraFiles));
} else if (command === "fix-ci") {
  if (!fileFlag) { console.error("Usage: codex-mimo fix-ci --file <ci.log> [task]"); process.exit(2); }
  if (dryRun) {
    console.log(`[dry-run] codex-mimo fix-ci --file ${fileFlag} "${task}"`);
    process.exit(0);
  }
  printDirectResult("fix-ci", await runFixCi(effectiveCwd, fileFlag, task || undefined));
} else if (command === "compose-worker") {
  const jobId = extractFlag("--job-id");
  if (!jobId) {
    console.error("Usage: codex-mimo compose-worker --job-id <job-id> [--cwd <path>]");
    process.exit(2);
  }
  await runComposeJobWorker(effectiveCwd, jobId);
} else if (command === "compose") {
  if (!workflowFlag) {
    console.error(`Usage: codex-mimo compose --workflow <${composeWorkflowUsage()}> [task]`);
    process.exit(2);
  }

  const result = await runComposeWorkflow({
    cwd: effectiveCwd,
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
  process.exit(composeStatusExitCode(result.status));
} else if (command === "sessions") {
  const store = new SessionStore(effectiveCwd);
  const sessions = store.list();
  const output = sessions.length === 0 ? { sessions: [], message: "No sessions found." } : { sessions };
  console.log(JSON.stringify(output, null, 2));
} else if (command === "resume") {
  if (!sessionFlag) { console.error("Usage: codex-mimo resume --session <id> <task>"); process.exit(2); }
  if (dryRun) {
    console.log(`[dry-run] codex-mimo resume --session ${sessionFlag} "${task}"`);
    process.exit(0);
  }
  printDirectResult("resume", await runResume(effectiveCwd, sessionFlag, task || undefined, extraFiles));
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(2);
}
