import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  captureGitHead,
  captureGitStatus,
  type GitFileFingerprint,
  type GitHeadSnapshot,
  type GitStatusSnapshot
} from "../git/diff.js";
import { renameWithWindowsRetry } from "./atomic-file.js";
import { updateJobAuthoritative } from "./job-store.js";
import type {
  EffectiveProgressKind,
  JobAcceptanceSummary,
  JobRecord,
  JobReportPaths
} from "./jobs.js";

export type AcceptanceSnapshot = JobAcceptanceSummary;

export interface JobCheckpoint {
  version: 1;
  jobId: string;
  chainId: string;
  objective: string;
  workflow?: string;
  sliceId?: string;
  sessionId?: string | null;
  repositoryFingerprint: string;
  contextFiles: string[];
  changedFiles: string[];
  completedSlices: string[];
  completedChecklist: string[];
  remainingChecklist: string[];
  acceptance: AcceptanceSnapshot;
  lastProgressAt?: string;
  lastProgressKind?: string;
  lastCommand?: string;
  artifactPaths: JobReportPaths;
}

export interface WriteJobCheckpointInput {
  job: JobRecord;
  objective: string;
  contextFiles?: string[];
  changedFiles?: string[];
  completedSlices?: string[];
  existingReportPaths?: JobReportPaths;
  reportDir?: string;
  acceptance?: AcceptanceSnapshot;
  captureHead?: typeof captureGitHead;
  captureStatus?: typeof captureGitStatus;
}

export interface ResumeConflictCheck {
  repositoryFingerprint: string;
}

export interface ResumeConflict {
  code: "resume_conflict";
  paths: string[];
}

const REMAINING_CHECKLIST_FALLBACK = [
  "Continue from the last incomplete step in the objective."
] as const;

const CONTEXT_TOOLS = new Set(["read", "write", "edit", "apply_patch"]);

export function computeRepositoryFingerprint(
  headOid: string,
  relevantFiles: string[],
  fingerprints: Record<string, GitFileFingerprint | string>
): string {
  const unique = [...new Set(relevantFiles.map((file) => file.replace(/\\/g, "/")))].sort();
  const lines = [headOid || "unborn"];
  for (const file of unique) {
    const entry = fingerprints[file];
    const hash = typeof entry === "string"
      ? entry
      : entry?.contentHash ?? "missing";
    lines.push(`${file}:${hash}`);
  }
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

export async function writeJobCheckpoint(
  input: WriteJobCheckpointInput
): Promise<JobReportPaths> {
  const reportDir = input.reportDir ??
    path.join(input.job.cwd, ".codex-mimo", "reports");
  fs.mkdirSync(reportDir, { recursive: true });

  const changedFiles = normalizePaths(input.changedFiles ?? input.job.changedFiles);
  const contextFiles = normalizePaths(
    input.contextFiles?.length
      ? input.contextFiles
      : collectContextFilesFromEvents(input.job.eventsFile, changedFiles)
  );
  const relevantFiles = normalizePaths([...contextFiles, ...changedFiles]);

  const captureHead = input.captureHead ?? captureGitHead;
  const captureStatus = input.captureStatus ?? captureGitStatus;
  const [head, status] = await Promise.all([
    captureHead(input.job.cwd),
    captureStatus(input.job.cwd)
  ]);
  const repositoryFingerprint = computeRepositoryFingerprint(
    head.oid,
    relevantFiles,
    status.fingerprints
  );
  const workflow = readWorkflow(input.job.request);
  const checkpointPath = path.join(reportDir, `${input.job.id}.checkpoint.json`);
  const existingPaths = normalizeCheckpointReportPaths(input.existingReportPaths ?? input.job.reportPaths);
  const artifactPaths: JobReportPaths = {
    ...existingPaths,
    checkpoint: checkpointPath.replace(/\\/g, "/")
  };
  const checkpoint: JobCheckpoint = {
    version: 1,
    jobId: input.job.id,
    chainId: input.job.chainId ?? input.job.id,
    objective: input.objective,
    ...(workflow ? { workflow } : {}),
    ...(input.job.sliceId ? { sliceId: input.job.sliceId } : {}),
    sessionId: input.job.sessionId ?? null,
    repositoryFingerprint,
    contextFiles,
    changedFiles,
    completedSlices: input.completedSlices ?? [],
    completedChecklist: [],
    remainingChecklist: [...REMAINING_CHECKLIST_FALLBACK],
    acceptance: input.acceptance ?? input.job.acceptance ?? { stages: [] },
    ...(input.job.lastProgressAt ? { lastProgressAt: input.job.lastProgressAt } : {}),
    ...(input.job.lastProgressKind ? { lastProgressKind: input.job.lastProgressKind } : {}),
    ...(input.job.lastCommand ? { lastCommand: input.job.lastCommand } : {}),
    artifactPaths
  };

  writeCheckpointAtomically(checkpointPath, checkpoint);
  return artifactPaths;
}

export function readJobCheckpoint(filePath: string): JobCheckpoint | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as JobCheckpoint;
    if (parsed.version !== 1 || typeof parsed.jobId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export const RESUMABLE_FAILURE_CODES = new Set([
  "build_failed",
  "tests_failed",
  "diff_check_failed",
  "delivery_contract_missing",
  "slice_failed"
]);

export async function captureRepositoryFingerprint(
  cwd: string,
  relevantFiles: string[],
  captureHead: typeof captureGitHead = captureGitHead,
  captureStatus: typeof captureGitStatus = captureGitStatus
): Promise<string> {
  const [head, status] = await Promise.all([captureHead(cwd), captureStatus(cwd)]);
  return computeRepositoryFingerprint(head.oid, relevantFiles, status.fingerprints);
}

export function detectResumeConflict(
  checkpoint: JobCheckpoint,
  current: ResumeConflictCheck
): ResumeConflict | null {
  if (current.repositoryFingerprint === checkpoint.repositoryFingerprint) return null;
  return {
    code: "resume_conflict",
    paths: normalizePaths([...checkpoint.contextFiles, ...checkpoint.changedFiles])
  };
}

export function collectContextFilesFromEvents(
  eventsFile: string,
  fallbackChangedFiles: string[] = []
): string[] {
  if (!fs.existsSync(eventsFile)) {
    return normalizePaths(fallbackChangedFiles);
  }

  const paths = new Set<string>();
  for (const line of fs.readFileSync(eventsFile, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as Record<string, unknown>;
      if (raw.type !== "tool_use") continue;
      const part = raw.part;
      if (typeof part !== "object" || part === null || Array.isArray(part)) continue;
      const tool = String((part as Record<string, unknown>).tool ??
        (part as Record<string, unknown>).name ?? "").toLowerCase();
      if (!CONTEXT_TOOLS.has(tool)) continue;
      const state = (part as Record<string, unknown>).state;
      const input = typeof state === "object" && state !== null && !Array.isArray(state)
        ? (state as Record<string, unknown>).input
        : undefined;
      const filePath = readPathFromInput(input);
      if (filePath) paths.add(filePath);
    } catch {
      continue;
    }
  }

  if (paths.size === 0) return normalizePaths(fallbackChangedFiles);
  return normalizePaths([...paths]);
}

export async function persistJobCheckpoint(
  cwd: string,
  job: JobRecord,
  options: {
    objective?: string;
    contextFiles?: string[];
    changedFiles?: string[];
  } = {}
): Promise<JobReportPaths> {
  const reportPaths = await writeJobCheckpoint({
    job,
    objective: options.objective ?? job.task,
    ...(options.contextFiles ? { contextFiles: options.contextFiles } : {}),
    ...(options.changedFiles ? { changedFiles: options.changedFiles } : {}),
    existingReportPaths: job.reportPaths
  });
  await updateJobAuthoritative(cwd, job.id, {
    reportPaths: {
      ...job.reportPaths,
      ...reportPaths
    }
  });
  return reportPaths;
}

function writeCheckpointAtomically(checkpointPath: string, checkpoint: JobCheckpoint): void {
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  const temporary = `${checkpointPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(checkpoint, null, 2), "utf8");
    renameWithWindowsRetry(temporary, checkpointPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function normalizePaths(paths: Iterable<string>): string[] {
  return [...new Set([...paths].map((file) => file.replace(/\\/g, "/")).filter(Boolean))].sort();
}

function normalizeCheckpointReportPaths(reportPaths?: JobReportPaths): JobReportPaths {
  if (!reportPaths) return {};
  const normalize = (value?: string) =>
    value === undefined ? undefined : value.replace(/\\/g, "/");
  return {
    ...reportPaths,
    ...(reportPaths.json ? { json: normalize(reportPaths.json)! } : {}),
    ...(reportPaths.markdown ? { markdown: normalize(reportPaths.markdown)! } : {}),
    ...(reportPaths.eventsJsonl ? { eventsJsonl: normalize(reportPaths.eventsJsonl)! } : {}),
    ...(reportPaths.result ? { result: normalize(reportPaths.result)! } : {}),
    ...(reportPaths.plan ? { plan: normalize(reportPaths.plan)! } : {}),
    ...(reportPaths.verification ? { verification: normalize(reportPaths.verification)! } : {}),
    ...(reportPaths.diff ? { diff: normalize(reportPaths.diff)! } : {}),
    ...(reportPaths.checkpoint ? { checkpoint: normalize(reportPaths.checkpoint)! } : {}),
    ...(reportPaths.slices ? { slices: normalize(reportPaths.slices)! } : {}),
    ...(reportPaths.executionEvidence
      ? { executionEvidence: normalize(reportPaths.executionEvidence)! }
      : {})
  };
}

function readWorkflow(request: unknown): string | undefined {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return undefined;
  const workflow = (request as Record<string, unknown>).workflow;
  return typeof workflow === "string" && workflow.trim() ? workflow : undefined;
}

function readPathFromInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const value = record.file_path ?? record.filepath ?? record.filePath ?? record.path;
  return typeof value === "string" && value.trim() ? value.replace(/\\/g, "/") : undefined;
}
