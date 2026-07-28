import fs from "node:fs";
import path from "node:path";

import type { AcceptanceStageResult } from "./acceptance.js";
import { extractFinalText, parseMimoJsonLines } from "./events.js";
import {
  detectReadOnlyViolationFiles,
  mergeChangedFiles
} from "./post-checks.js";
import { diffReviewPrompt } from "../core/prompt.js";
import { CODEX_MIMO_READONLY_AGENT } from "../core/safety-contracts.js";
import { captureGitStatus, type GitStatusSnapshot } from "../git/diff.js";
import { preparePromptTransport } from "../mimo/prompt-transport.js";
import { buildMimoRunArgs } from "../mimo/run-json.js";
import { buildBridgeRuntimeEnvironment } from "../mimo/runtime-config.js";
import { runMimoCliStreaming } from "../mimo/streaming-runner.js";

export interface DiffReviewFinding {
  severity: "blocker" | "major" | "minor" | "info";
  message: string;
  path?: string;
}

export interface DiffReviewVerdict {
  verdict: "pass" | "fail";
  findings: DiffReviewFinding[];
}

const VALID_SEVERITIES = new Set<DiffReviewFinding["severity"]>([
  "blocker",
  "major",
  "minor",
  "info"
]);

export interface ReadOnlyDiffReviewInput {
  cwd: string;
  sessionId?: string | null;
  diffPath: string;
  signal?: AbortSignal;
  runMimo?: typeof runMimoCliStreaming;
  captureStatus?: typeof captureGitStatus;
  readDiffContent?: (diffPath: string, cwd: string) => string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFinding(value: unknown): DiffReviewFinding | null {
  if (!isRecord(value)) {
    return null;
  }
  const severity = value.severity;
  if (typeof severity !== "string" || !VALID_SEVERITIES.has(severity as DiffReviewFinding["severity"])) {
    return null;
  }
  const message = value.message;
  if (typeof message !== "string" || !message.trim()) {
    return null;
  }
  return {
    severity: severity as DiffReviewFinding["severity"],
    message: message.trim(),
    ...(typeof value.path === "string" && value.path.trim() ? { path: value.path.trim() } : {})
  };
}

function normalizeVerdict(value: unknown): DiffReviewVerdict | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.verdict !== "pass" && value.verdict !== "fail") {
    return null;
  }
  if (!Array.isArray(value.findings)) {
    return null;
  }
  const findings: DiffReviewFinding[] = [];
  for (const item of value.findings) {
    const finding = normalizeFinding(item);
    if (!finding) {
      return null;
    }
    findings.push(finding);
  }
  return { verdict: value.verdict, findings };
}

function extractJsonCandidates(finalText: string): string[] {
  const candidates: string[] = [];
  for (const match of finalText.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim());
  }
  for (const match of finalText.matchAll(/\{[\s\S]*?"verdict"\s*:[\s\S]*?\}/g)) {
    candidates.push(match[0]);
  }
  candidates.push(finalText.trim());
  return candidates;
}

export function parseDiffReviewVerdict(finalText: string): DiffReviewVerdict | null {
  for (const candidate of extractJsonCandidates(finalText)) {
    if (!candidate) {
      continue;
    }
    try {
      const verdict = normalizeVerdict(JSON.parse(candidate));
      if (verdict) {
        return verdict;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function defaultReadDiffContent(diffPath: string, cwd: string): string | null {
  const absolute = path.isAbsolute(diffPath) ? diffPath : path.join(cwd, diffPath);
  if (!fs.existsSync(absolute)) {
    return null;
  }
  return fs.readFileSync(absolute, "utf8");
}

function resolveDiffFile(diffPath: string, cwd: string): string {
  return path.isAbsolute(diffPath) ? diffPath : path.join(cwd, diffPath);
}

function hasDiffContent(diffPath: string, cwd: string, readDiffContent: typeof defaultReadDiffContent): boolean {
  const content = readDiffContent(diffPath, cwd);
  return Boolean(content?.trim());
}

function significantFindings(findings: DiffReviewFinding[]): DiffReviewFinding[] {
  return findings.filter((finding) => finding.severity === "blocker" || finding.severity === "major");
}

function warningFindings(findings: DiffReviewFinding[]): DiffReviewFinding[] {
  return findings.filter((finding) => finding.severity === "minor" || finding.severity === "info");
}

function formatFindings(findings: DiffReviewFinding[]): string {
  return findings.map((finding) => finding.message).join("; ");
}

function readOnlyViolationResult(violations: string[]): AcceptanceStageResult {
  return {
    stage: "diff_check",
    outcome: "failed",
    reason: `Read-only diff review modified files: ${violations.join(", ")}`,
    suggestion: "Ensure the diff review agent does not write files, then rerun the diff check."
  };
}

function evaluateVerdict(verdict: DiffReviewVerdict): AcceptanceStageResult {
  const blockers = significantFindings(verdict.findings);
  if (blockers.length > 0) {
    return {
      stage: "diff_check",
      outcome: "failed",
      reason: formatFindings(blockers),
      suggestion: "Address the diff review findings, then rerun the diff check.",
      stdout: JSON.stringify(verdict)
    };
  }

  if (verdict.verdict === "fail") {
    const warnings = warningFindings(verdict.findings);
    if (warnings.length > 0 && warnings.length === verdict.findings.length) {
      return {
        stage: "diff_check",
        outcome: "passed",
        stdout: JSON.stringify({ warnings })
      };
    }
    return {
      stage: "diff_check",
      outcome: "failed",
      reason: formatFindings(verdict.findings) || "Diff review verdict failed.",
      suggestion: "Address the diff review findings, then rerun the diff check.",
      stdout: JSON.stringify(verdict)
    };
  }

  const warnings = warningFindings(verdict.findings);
  if (warnings.length > 0) {
    return {
      stage: "diff_check",
      outcome: "passed",
      stdout: JSON.stringify({ warnings })
    };
  }

  return { stage: "diff_check", outcome: "passed" };
}

export async function runReadOnlyDiffReview(
  input: ReadOnlyDiffReviewInput
): Promise<AcceptanceStageResult> {
  const captureStatus = input.captureStatus ?? captureGitStatus;
  const readDiffContent = input.readDiffContent ?? defaultReadDiffContent;

  if (!hasDiffContent(input.diffPath, input.cwd, readDiffContent)) {
    return {
      stage: "diff_check",
      outcome: "not_applicable",
      reason: "no_diff"
    };
  }

  const statusBefore = await captureStatus(input.cwd, { signal: input.signal });
  const prompt = preparePromptTransport(diffReviewPrompt(input.diffPath), { cwd: input.cwd });
  const diffFile = resolveDiffFile(input.diffPath, input.cwd);
  const args = buildMimoRunArgs({
    cwd: input.cwd,
    agent: CODEX_MIMO_READONLY_AGENT,
    message: prompt.message,
    title: "codex-mimo diff-review",
    ...(input.sessionId ? { session: input.sessionId } : {}),
    files: mergeChangedFiles(prompt.files, [diffFile])
  });

  const runMimo = input.runMimo ?? runMimoCliStreaming;
  const run = await runMimo(input.cwd, args, {
    signal: input.signal,
    env: buildBridgeRuntimeEnvironment()
  });

  const statusAfter = await captureStatus(input.cwd, { signal: input.signal });
  const violations = detectReadOnlyViolationFiles(false, [], statusBefore, statusAfter);
  if (violations.length > 0) {
    return readOnlyViolationResult(violations);
  }

  if (run.exitCode !== 0) {
    return {
      stage: "diff_check",
      outcome: "failed",
      exitCode: run.exitCode,
      reason: `Diff review MiMo process exited with code ${run.exitCode}`,
      stderr: run.stderr,
      suggestion: "Fix the diff review run error, then rerun the diff check."
    };
  }

  const finalText = extractFinalText(parseMimoJsonLines(run.stdout));
  const verdict = parseDiffReviewVerdict(finalText);
  if (!verdict) {
    return {
      stage: "diff_check",
      outcome: "failed",
      reason: "delivery_contract_missing",
      suggestion: "Diff review must end with a valid JSON verdict envelope.",
      stdout: finalText
    };
  }

  return evaluateVerdict(verdict);
}

export function diffReviewWarningsFromResult(result: AcceptanceStageResult): DiffReviewFinding[] {
  if (!result.stdout) {
    return [];
  }
  try {
    const parsed = JSON.parse(result.stdout) as { warnings?: DiffReviewFinding[] };
    return Array.isArray(parsed.warnings) ? parsed.warnings : [];
  } catch {
    return [];
  }
}
