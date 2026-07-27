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

  const explicitSummary = lines.findIndex((line) =>
    /^#{1,6}\s+(?:summary|result|摘要|总结)\s*$/i.test(line));
  const substantive = (explicitSummary >= 0
    ? lines.slice(explicitSummary + 1).find((line) => !/^#{1,6}\s+/.test(line))
    : undefined) ??
    lines.find((line) => !/^#{1,6}\s+/.test(line)) ??
    lines[0];
  const sentence = substantive.match(/^.*?[.!?。！？](?:\s|$)/)?.[0] ?? substantive;
  const singleLine = sentence
    .replace(/^[-*+]\s+/, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return singleLine
    ? redactDiagnosticText(singleLine).slice(0, maxChars)
    : undefined;
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

export function readVerificationArtifact(
  file: string | undefined
): JobVerificationDetails[] | undefined {
  const raw = readTextArtifact(file);
  return raw ? parseVerificationArtifact(raw) : undefined;
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
