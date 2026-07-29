import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { parseMimoJsonLines } from "../compose/events.js";
import type { MimoCommandEvidence, NormalizedMimoEvent } from "../compose/events.js";
import type {
  GitCommitChangeSnapshot,
  GitDiffSnapshot,
  GitHeadSnapshot,
  GitStatusSnapshot
} from "../git/diff.js";
import type { StreamingRunResult } from "../mimo/streaming-runner.js";
import { renameWithWindowsRetry } from "./atomic-file.js";
import type { ChangeDetectionResult } from "./changed-files.js";
import { redactDiagnosticText } from "./job-output.js";
import type { ExecutionCallbackSummary, JobFailureCause, JobRecord } from "./jobs.js";

export interface JobExecutionEvidence {
  version: 1;
  jobId: string;
  capturedAt: string;
  reconciliationAttempts: number;
  run: Pick<StreamingRunResult, "exitCode" | "terminationReason">;
  runSessionId?: string;
  eventSessionMismatch?: true;
  failureCauses?: JobFailureCause[];
  executionCallback?: ExecutionCallbackSummary;
  gitStatusBefore?: GitStatusSnapshot;
  gitStatusAfter?: GitStatusSnapshot;
  gitHeadBefore?: GitHeadSnapshot;
  gitHeadAfter?: GitHeadSnapshot;
  diff?: GitDiffSnapshot;
  commitChanges?: GitCommitChangeSnapshot;
  changeDetection: ChangeDetectionResult;
  commandEvidence: MimoCommandEvidence[];
  finalRepositoryFingerprint: string;
  resultPath?: string;
}

export function resolveExecutionEvidencePath(job: Pick<JobRecord, "cwd" | "id">): string {
  return path.join(job.cwd, ".codex-mimo", "reports", `${job.id}.execution.json`);
}

export function writeExecutionEvidence(
  job: JobRecord,
  evidence: Omit<JobExecutionEvidence, "version" | "jobId" | "capturedAt" | "resultPath">,
  finalText: string
): { evidence: JobExecutionEvidence; evidencePath: string; resultPath?: string } {
  const evidencePath = resolveExecutionEvidencePath(job);
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  const resultPath = writeExecutionResult(job, finalText);
  const record: JobExecutionEvidence = {
    version: 1,
    jobId: job.id,
    capturedAt: new Date().toISOString(),
    ...evidence,
    commandEvidence: evidence.commandEvidence.map((entry) => ({
      ...entry,
      command: redactDiagnosticText(entry.command),
      commandHash: hashCommand(entry.command)
    })),
    ...(evidence.diff
      ? {
          diff: {
            ...evidence.diff,
            diffStat: redactDiagnosticText(evidence.diff.diffStat),
            diff: redactDiagnosticText(evidence.diff.diff)
          }
        }
      : {}),
    ...(evidence.commitChanges
      ? {
          commitChanges: {
            ...evidence.commitChanges,
            commits: evidence.commitChanges.commits.map(redactDiagnosticText)
          }
        }
      : {}),
    ...(resultPath ? { resultPath } : {})
  };
  writeJsonAtomically(evidencePath, record);
  return { evidence: record, evidencePath, ...(resultPath ? { resultPath } : {}) };
}

export function readExecutionEvidence(job: JobRecord): JobExecutionEvidence | undefined {
  const file = resolveExecutionEvidencePath(job);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as JobExecutionEvidence;
    if (parsed.version !== 1 || parsed.jobId !== job.id) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function updateExecutionEvidenceAttempts(
  job: JobRecord,
  evidence: JobExecutionEvidence,
  attempts: number
): JobExecutionEvidence {
  const updated = { ...evidence, reconciliationAttempts: attempts };
  writeJsonAtomically(resolveExecutionEvidencePath(job), updated);
  return updated;
}

export function readExecutionEvents(
  job: JobRecord,
  evidence?: JobExecutionEvidence
): NormalizedMimoEvent[] {
  if (fs.existsSync(job.eventsFile)) {
    const events = parseMimoJsonLines(fs.readFileSync(job.eventsFile, "utf8"));
    if (events.length > 0) return events;
  }
  if (evidence?.resultPath && fs.existsSync(evidence.resultPath)) {
    const text = fs.readFileSync(evidence.resultPath, "utf8").trim();
    return text ? [{ type: "message", text, raw: { type: "text" } }] : [];
  }
  return [];
}

function writeExecutionResult(job: JobRecord, finalText: string): string | undefined {
  if (!finalText.trim()) return undefined;
  const resultPath = path.join(job.cwd, ".codex-mimo", "reports", `${job.id}.result.md`);
  writeTextAtomically(resultPath, redactDiagnosticText(finalText));
  return resultPath;
}

function writeJsonAtomically(file: string, value: unknown): void {
  writeTextAtomically(file, JSON.stringify(value, null, 2));
}

function writeTextAtomically(file: string, value: string): void {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, value, "utf8");
    renameWithWindowsRetry(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function hashCommand(command: string): string {
  const normalized = command.trim().replace(/\s+/g, " ");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}
