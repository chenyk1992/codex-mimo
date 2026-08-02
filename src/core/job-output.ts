import fs from "node:fs";
import { extractFinalText, parseMimoJsonLines } from "../compose/events.js";
import type {
  FullArtifactTooLarge,
  FullJobResult,
  JobRecord,
  JobVerificationDetails
} from "./jobs.js";

export const OUTPUT_SUMMARY_MAX_CHARS = 500;
export const FULL_ARTIFACT_MAX_BYTES = 1_000_000;

export function readFinalJobOutput(eventsFile: string): string | undefined {
  try {
    const raw = fs.readFileSync(eventsFile, "utf8");
    const finalText = extractFinalText(parseMimoJsonLines(raw));
    return finalText || undefined;
  } catch {
    return undefined;
  }
}

export function summarizeJobOutput(
  output: string | undefined,
  maxChars = OUTPUT_SUMMARY_MAX_CHARS
): string | undefined {
  const lines = output
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines || lines.length === 0) return undefined;

  const explicitSummary = findLastLineIndex(lines, isExplicitSummaryHeading);
  const findingsSection = findLastLineIndex(lines, isFindingsHeading);
  const preferredConclusion = [...lines].reverse().find((line) =>
    /^(?:#{1,6}\s+)?(?:\*{1,2})?(?:verdict|judgment|conclusion|finding|结论|结果|判定)(?:\*{1,2})?\s*[:：]/i
      .test(line)
  );
  const synthesizedFindingsHeading = [...lines].reverse().find(isSynthesizedFindingsHeading);
  const substantive = (explicitSummary >= 0
    ? lines.slice(explicitSummary + 1).find(isSubstantiveSummaryLine)
    : undefined) ??
    preferredConclusion ??
    (findingsSection >= 0
      ? lines.slice(findingsSection + 1).find(isSubstantiveSummaryLine)
      : undefined) ??
    synthesizedFindingsHeading ??
    lines.find((line) => isSubstantiveSummaryLine(line) && !isGenericOpening(line)) ??
    lines.find(isSubstantiveSummaryLine) ??
    lines[0];
  const sentence = substantive.match(/^.*?[.!?。！？](?:\s|$)/)?.[0] ?? substantive;
  const singleLine = sentence
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/\*{1,2}/g, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return singleLine
    ? redactDiagnosticText(singleLine).slice(0, maxChars)
    : undefined;
}

function isSubstantiveSummaryLine(line: string): boolean {
  return !/^#{1,6}\s+/.test(line) &&
    !/^(?:---+|\*\*\*+|___+)$/.test(line);
}

function isExplicitSummaryHeading(line: string): boolean {
  return /^#{1,6}\s+(?:summary|result|assessment|conclusion|verdict|摘要|总结|评估|结论|结果|判定)\s*$/i
    .test(line);
}

function isFindingsHeading(line: string): boolean {
  return /^#{1,6}\s+(?:findings?|issues?|问题)\s*$/i.test(line);
}

function isSynthesizedFindingsHeading(line: string): boolean {
  return /^#{1,6}\s+synthesized\s+findings?\b(?:\s*[-—:：].+)?$/i.test(line);
}

function isGenericOpening(line: string): boolean {
  return /^(?:i(?:'ve| have)|we(?:'ve| have))\s+(?:now\s+)?(?:have|gathered)\s+(?:all|enough|the necessary)\s+(?:the\s+)?(?:context|information|details)\b/i
    .test(line) ||
    /^(?:现在)?(?:我|我们)(?:已经|已)?(?:对.+)?(?:有了|具备了)(?:完整|充分|足够|必要).*(?:了解|上下文|信息|背景)/
      .test(line);
}

function findLastLineIndex(lines: readonly string[], predicate: (line: string) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index]!)) return index;
  }
  return -1;
}

export function readTextArtifact(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export function readSavedJobOutput(job: JobRecord): string | undefined {
  return readTextArtifact(job.reportPaths?.result) ?? readFinalJobOutput(job.eventsFile);
}

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:--)(?:api[_-]?key|token|password|secret)(?:=|\s+))([^\s"'`]+)/gi,
      "$1[REDACTED]"
    )
    .replace(
      /([?&](?:api[_-]?key|token|password|secret)=)([^&\s]+)/gi,
      "$1[REDACTED]"
    )
    .replace(
      /\b(?:ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g,
      "[REDACTED]"
    )
    .replace(
      /((?:api[_-]?key|token|password|secret)\s*[:=]\s*)([^\s"'`]+)/gi,
      "$1[REDACTED]"
    );
}

export function readKeyVerificationError(file: string | undefined): string | undefined {
  const read = readDiagnosticArtifact(file, "verification");
  if (!read.content) return undefined;
  const failed = parseVerificationArtifact(read.content)?.find((result) => !result.passed);
  const evidence = failed?.stderr.trim() || failed?.stdout.trim();
  return evidence
    ? redactDiagnosticText(evidence)
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500)
    : undefined;
}

function parseVerificationArtifact(raw: string): JobVerificationDetails[] | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const results = parsed.filter((entry): entry is JobVerificationDetails =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as JobVerificationDetails).command === "string" &&
      ((entry as JobVerificationDetails).exitCode === null ||
        Number.isInteger((entry as JobVerificationDetails).exitCode)) &&
      typeof (entry as JobVerificationDetails).passed === "boolean" &&
      typeof (entry as JobVerificationDetails).stdout === "string" &&
      typeof (entry as JobVerificationDetails).stderr === "string" &&
      ((entry as JobVerificationDetails).durationMs === undefined ||
        (typeof (entry as JobVerificationDetails).durationMs === "number" &&
          (entry as JobVerificationDetails).durationMs! >= 0))
    );
    return results.length === parsed.length ? results : undefined;
  } catch {
    return undefined;
  }
}

export function readJobDiagnostics(
  job: JobRecord,
  fallbackOutput?: string
): Pick<
  FullJobResult,
  "output" | "plan" | "verificationDetails" | "jobLog" | "diff" | "artifactErrors"
> {
  const errors: FullArtifactTooLarge[] = [];
  const outputRead = job.reportPaths?.result
    ? readDiagnosticArtifact(job.reportPaths.result, "output")
    : readDiagnosticFallback(fallbackOutput, job.eventsFile, "output");
  const planRead = readDiagnosticArtifact(job.reportPaths?.plan, "plan");
  const verificationRead = readDiagnosticArtifact(
    job.reportPaths?.verification,
    "verification"
  );
  const jobLogRead = readDiagnosticArtifact(job.logFile, "job_log");
  const diffRead = readDiagnosticArtifact(job.reportPaths?.diff, "diff");
  for (const read of [outputRead, planRead, verificationRead, jobLogRead, diffRead]) {
    if (read.error) errors.push(read.error);
  }

  const verificationDetails = verificationRead.content
    ? parseVerificationArtifact(verificationRead.content)?.map((result) => ({
        ...result,
        command: redactDiagnosticText(result.command),
        stdout: redactDiagnosticText(result.stdout),
        stderr: redactDiagnosticText(result.stderr)
      }))
    : undefined;
  return {
    ...(outputRead.content ? { output: redactDiagnosticText(outputRead.content) } : {}),
    ...(planRead.content ? { plan: redactDiagnosticText(planRead.content) } : {}),
    ...(verificationDetails ? { verificationDetails } : {}),
    ...(jobLogRead.content ? { jobLog: redactDiagnosticText(jobLogRead.content) } : {}),
    ...(diffRead.content ? { diff: redactDiagnosticText(diffRead.content) } : {}),
    ...(errors.length > 0 ? { artifactErrors: errors } : {})
  };
}

interface DiagnosticArtifactRead {
  content?: string;
  error?: FullArtifactTooLarge;
}

function readDiagnosticArtifact(
  file: string | undefined,
  artifact: FullArtifactTooLarge["artifact"]
): DiagnosticArtifactRead {
  if (!file) return {};
  try {
    const bytes = fs.statSync(file).size;
    if (bytes > FULL_ARTIFACT_MAX_BYTES) {
      return {
        error: { code: "artifact_too_large", artifact, path: file, bytes }
      };
    }
    return { content: fs.readFileSync(file, "utf8") };
  } catch {
    return {};
  }
}

function readDiagnosticFallback(
  content: string | undefined,
  path: string,
  artifact: FullArtifactTooLarge["artifact"]
): DiagnosticArtifactRead {
  if (!content) return {};
  const bytes = Buffer.byteLength(content, "utf8");
  return bytes > FULL_ARTIFACT_MAX_BYTES
    ? { error: { code: "artifact_too_large", artifact, path, bytes } }
    : { content };
}
