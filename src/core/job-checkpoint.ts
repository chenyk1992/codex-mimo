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
import type { WorkspaceManifest } from "./changed-files.js";
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
  /** Stable file-level state for precise resume conflict reporting. */
  fileFingerprints?: Record<string, string>;
  contextFiles: string[];
  changedFiles: string[];
  completedSlices: string[];
  completedChecklist: string[];
  remainingChecklist: string[];
  acceptance: AcceptanceSnapshot;
  workspaceManifestBefore?: WorkspaceManifest;
  lastProgressAt?: string;
  lastProgressKind?: string;
  lastCommand?: string;
  artifactPaths: JobReportPaths;
}

export interface WriteJobCheckpointInput {
  job: JobRecord;
  /** Workspace used to read fingerprints; reports still belong to job.cwd/reportDir. */
  sourceCwd?: string;
  objective: string;
  contextFiles?: string[];
  changedFiles?: string[];
  completedSlices?: string[];
  existingReportPaths?: JobReportPaths;
  reportDir?: string;
  acceptance?: AcceptanceSnapshot;
  workspaceManifestBefore?: WorkspaceManifest;
  captureHead?: typeof captureGitHead;
  captureStatus?: typeof captureGitStatus;
}

export interface ResumeConflictCheck {
  repositoryFingerprint: string;
  fileFingerprints?: Record<string, string>;
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

  const sourceCwd = input.sourceCwd ?? input.job.cwd;
  const changedFiles = normalizeResumePaths(sourceCwd, input.changedFiles ?? input.job.changedFiles);
  const contextFiles = normalizeResumePaths(sourceCwd,
    input.contextFiles?.length
      ? input.contextFiles
      : collectContextFilesFromEvents(input.job.eventsFile, changedFiles)
  );
  const relevantFiles = normalizePaths([...contextFiles, ...changedFiles]);

  const fileFingerprints = captureRelevantFileFingerprints(sourceCwd, relevantFiles);
  // Resume only depends on files this job read or changed, not unrelated commits
  // or volatile generated files elsewhere in the workspace.
  const repositoryFingerprint = computeRepositoryFingerprint("", relevantFiles, fileFingerprints);
  const workflow = readWorkflow(input.job.request);
  const checkpointPath = path.join(reportDir, `${input.job.id}.checkpoint.json`);
  const existingCheckpoint = readJobCheckpoint(checkpointPath);
  const workspaceManifestBefore =
    input.workspaceManifestBefore ?? existingCheckpoint?.workspaceManifestBefore;
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
    fileFingerprints,
    contextFiles,
    changedFiles,
    completedSlices: input.completedSlices ?? [],
    completedChecklist: [],
    remainingChecklist: [...REMAINING_CHECKLIST_FALLBACK],
    acceptance: input.acceptance ?? input.job.acceptance ?? { stages: [] },
    ...(workspaceManifestBefore ? { workspaceManifestBefore } : {}),
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

export async function captureResumeConflictCheck(
  cwd: string,
  checkpoint: JobCheckpoint
): Promise<ResumeConflictCheck> {
  if (!checkpoint.fileFingerprints) {
    const relevantFiles = normalizeResumePaths(cwd, [
      ...checkpoint.contextFiles,
      ...checkpoint.changedFiles
    ]);
    return {
      repositoryFingerprint: await captureRepositoryFingerprint(cwd, relevantFiles)
    };
  }
  const relevantFiles = Object.keys(checkpoint.fileFingerprints);
  const fileFingerprints = captureRelevantFileFingerprints(cwd, relevantFiles);
  return {
    repositoryFingerprint: computeRepositoryFingerprint("", relevantFiles, fileFingerprints),
    fileFingerprints
  };
}

export function detectResumeConflict(
  checkpoint: JobCheckpoint,
  current: ResumeConflictCheck
): ResumeConflict | null {
  if (checkpoint.fileFingerprints && current.fileFingerprints) {
    const paths = normalizePaths([
      ...Object.keys(checkpoint.fileFingerprints),
      ...Object.keys(current.fileFingerprints)
    ]).filter((file) => checkpoint.fileFingerprints![file] !== current.fileFingerprints![file]);
    return paths.length > 0 ? { code: "resume_conflict", paths } : null;
  }
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
    workspaceManifestBefore?: WorkspaceManifest;
    captureHead?: typeof captureGitHead;
    captureStatus?: typeof captureGitStatus;
    sourceCwd?: string;
  } = {}
): Promise<JobReportPaths> {
  const reportPaths = await writeJobCheckpoint({
    job,
    objective: options.objective ?? job.task,
    ...(options.contextFiles ? { contextFiles: options.contextFiles } : {}),
    ...(options.changedFiles ? { changedFiles: options.changedFiles } : {}),
    ...(options.workspaceManifestBefore
      ? { workspaceManifestBefore: options.workspaceManifestBefore }
      : {}),
    ...(options.captureHead ? { captureHead: options.captureHead } : {}),
    ...(options.captureStatus ? { captureStatus: options.captureStatus } : {}),
    ...(options.sourceCwd ? { sourceCwd: options.sourceCwd } : {}),
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

const VOLATILE_RESUME_PATH_SEGMENTS = new Set([
  ".codex-mimo",
  "node_modules",
  "build",
  "dist",
  "out",
  "coverage",
  "target",
  ".gradle"
]);

function normalizeResumePaths(cwd: string, paths: Iterable<string>): string[] {
  const root = path.resolve(cwd);
  const normalized: string[] = [];
  for (const candidate of paths) {
    if (!candidate) continue;
    const absolute = path.resolve(root, candidate);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const file = relative.replace(/\\/g, "/");
    if (!file || isVolatileResumePath(file)) continue;
    try {
      if (fs.lstatSync(absolute).isDirectory()) continue;
    } catch {
      // A deleted relevant file must still be compared as "missing".
    }
    normalized.push(file);
  }
  return normalizePaths(normalized);
}

function isVolatileResumePath(file: string): boolean {
  const segments = file.split("/");
  return segments.some((segment) => VOLATILE_RESUME_PATH_SEGMENTS.has(segment)) ||
    /(?:^|\/)[^/]+\.(?:log|tmp)$/i.test(file);
}

function captureRelevantFileFingerprints(
  cwd: string,
  relevantFiles: string[]
): Record<string, string> {
  const root = path.resolve(cwd);
  return Object.fromEntries(relevantFiles.map((file) => {
    const absolute = path.resolve(root, file);
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) return [file, `symlink:${fs.readlinkSync(absolute)}`];
      if (!stat.isFile()) return [file, stat.isDirectory() ? "directory" : "special"];
      return [file, crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")];
    } catch {
      return [file, "missing"];
    }
  }));
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
