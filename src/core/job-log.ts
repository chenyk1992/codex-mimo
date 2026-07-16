import fs from "node:fs";
import path from "node:path";
import { normalizeMimoEvent, type NormalizedMimoEvent } from "../compose/events.js";
import { appendJobSignal } from "./job-signals.js";
import { readJob, resolveJobPaths, updateJob } from "./job-store.js";
import type { JobPhase } from "./jobs.js";
import { withProcessLock } from "./process-lock.js";

export function appendJobLogLine(logFile: string, message: string): void {
  const trimmed = message.trim();
  if (!trimmed) return;

  ensureParentDir(logFile);
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${trimmed}\n`, "utf8");
}

export function appendJobEventLine(eventsFile: string, line: string): void {
  const withoutNewline = line.replace(/\r?\n$/, "");
  if (!withoutNewline.trim()) return;

  ensureParentDir(eventsFile);
  fs.appendFileSync(eventsFile, `${withoutNewline}\n`, "utf8");
}

export function readRecentJobLogLines(logFile: string, count = 5): string[] {
  if (!fs.existsSync(logFile)) return [];

  return fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-count)
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, "").trim());
}

export async function appendRawAndNormalizedEvent(
  cwd: string,
  jobId: string,
  line: string
): Promise<NormalizedMimoEvent | undefined> {
  const rawLine = line.replace(/\r?\n$/, "");
  if (!rawLine.trim()) return undefined;

  return withProcessLock(resolveJobPaths(cwd, jobId).jobFile, () => {
    const job = readJob(cwd, jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    appendJobEventLine(job.eventsFile, rawLine);
    const event = normalizeLine(rawLine);
    if (job.status !== "running") return event;

    const phase = inferActivePhase(event);
    const summary = summarizeNormalizedEvent(event);
    if (summary) appendJobLogLine(job.logFile, summary);
    const updated = phase || summary
      ? updateJob(cwd, jobId, {
          ...(phase ? { phase } : {}),
          ...(summary ? { summary } : {})
        })
      : job;

    if (phase && phase !== job.phase) {
      appendJobSignal(updated.signalsFile, {
        jobId,
        kind: "phase_changed",
        level: "info",
        status: "running",
        phase,
        summary: summary ?? `${job.kind} job entered ${phase}.`
      });
    }
    if (summary) {
      appendJobSignal(updated.signalsFile, {
        jobId,
        kind: "milestone",
        level: event.type === "error" ? "error" : "info",
        status: "running",
        phase: updated.phase,
        summary
      });
    }
    return event;
  });
}

function normalizeLine(line: string): NormalizedMimoEvent {
  try {
    return normalizeMimoEvent(JSON.parse(line) as unknown);
  } catch {
    return { type: "raw", text: line, raw: line };
  }
}

function inferActivePhase(event: NormalizedMimoEvent): JobPhase | undefined {
  if (event.type === "diff") return "editing";
  if (event.type === "message" || event.type === "progress" || event.type === "error") {
    return "investigating";
  }
  if (event.type !== "tool") return undefined;
  const tool = event.toolName?.toLowerCase();
  if (tool === "edit" || tool === "write" || tool === "apply_patch") return "editing";
  if (tool === "bash" && event.text && VERIFY_COMMAND_PATTERN.test(event.text)) return "verifying";
  return "investigating";
}

function summarizeNormalizedEvent(event: NormalizedMimoEvent): string | undefined {
  const text = event.text?.trim();
  if (text) return text;
  if (event.type === "tool" && event.toolName) {
    return `Tool ${event.toolName}${event.status ? ` ${event.status}` : ""}.`;
  }
  if (event.type === "diff" && event.path) return `Changed ${event.path}.`;
  if (event.type === "usage" && event.usage) return "Usage updated.";
  if (event.type === "error") return "MiMoCode reported an error.";
  return undefined;
}

const VERIFY_COMMAND_PATTERN =
  /\b(?:tests?|lint|build|type-?check|check|verify|validate|pytest|jest|vitest|tsc|eslint)\b|(?:npm|pnpm|yarn)\s+test/i;

function ensureParentDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}
