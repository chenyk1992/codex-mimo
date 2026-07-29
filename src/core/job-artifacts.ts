import fs from "node:fs";
import path from "node:path";
import { redactDiagnosticText } from "./job-output.js";
import { publicProgressSummary } from "./public-summary.js";
import type {
  JobRecord,
  JobReportPaths,
  JobStatus,
  JobVerification,
  JobVerificationDetails
} from "./jobs.js";

export interface WriteJobArtifactsInput {
  job: JobRecord;
  status: JobStatus;
  errorCode?: string;
  changedFiles: string[];
  verification: JobVerificationDetails[];
  compactVerification?: JobVerification[];
  finalText: string;
  diff?: string;
  plan: boolean;
  reportDir?: string;
  diffsDir?: string;
  existingReportPaths?: JobReportPaths;
}

export function writeJobArtifacts(input: WriteJobArtifactsInput): JobReportPaths {
  const reportDir = input.reportDir ??
    path.join(input.job.cwd, ".codex-mimo", "reports");
  const diffsDir = input.diffsDir ??
    path.join(input.job.cwd, ".codex-mimo", "diffs");
  fs.mkdirSync(reportDir, { recursive: true });

  const finalText = redactDiagnosticText(input.finalText.trim());
  const result = finalText
    ? path.join(reportDir, `${input.job.id}.result.md`)
    : undefined;
  const plan = input.plan && finalText
    ? path.join(reportDir, `${input.job.id}.plan.md`)
    : undefined;
  const verification = input.verification.length > 0
    ? path.join(reportDir, `${input.job.id}.verification.json`)
    : undefined;
  const diffText = input.diff?.trim()
    ? redactDiagnosticText(input.diff.trim())
    : undefined;
  const diffPath = input.existingReportPaths?.diff ??
    (diffText ? path.join(diffsDir, `${input.job.id}.diff`) : undefined);
  const reportPaths: JobReportPaths = {
    ...input.existingReportPaths,
    json: input.existingReportPaths?.json ??
      path.join(reportDir, `${input.job.id}.json`),
    markdown: input.existingReportPaths?.markdown ??
      path.join(reportDir, `${input.job.id}.md`),
    ...(result ? { result } : {}),
    ...(plan ? { plan } : {}),
    ...(verification ? { verification } : {}),
    ...(diffPath ? { diff: diffPath } : {})
  };
  const storedReportPaths = normalizeReportPaths(reportPaths);

  if (result) fs.writeFileSync(result, finalText, "utf8");
  if (plan) fs.writeFileSync(plan, finalText, "utf8");
  if (verification) {
    const safeVerification = input.verification.map((entry) => ({
      ...entry,
      command: redactDiagnosticText(entry.command),
      stdout: redactDiagnosticText(entry.stdout),
      stderr: redactDiagnosticText(entry.stderr)
    }));
    fs.writeFileSync(verification, JSON.stringify(safeVerification, null, 2), "utf8");
  }
  if (diffText && !input.existingReportPaths?.diff && diffPath) {
    fs.mkdirSync(path.dirname(diffPath), { recursive: true });
    fs.writeFileSync(diffPath, diffText, "utf8");
  }

  const compactVerification: JobVerification[] = (
    input.compactVerification ??
    input.verification
  ).map(({ command, exitCode, passed, durationMs }) => ({
    command: redactDiagnosticText(command).slice(0, 240),
    exitCode,
    passed,
    ...(durationMs === undefined ? {} : { durationMs })
  }));
  const summary = publicProgressSummary({
    type: "job",
    status: input.status,
    ...(input.errorCode ? { errorCode: input.errorCode } : {})
  });
  const structural = {
    version: 1,
    id: input.job.id,
    createdAt: input.job.createdAt,
    kind: input.job.kind,
    status: input.status,
    summary,
    changedFiles: [...input.changedFiles],
    verification: compactVerification,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    reportPaths: storedReportPaths
  };

  if (!input.existingReportPaths?.json) {
    fs.writeFileSync(storedReportPaths.json!, JSON.stringify(structural, null, 2), "utf8");
  }
  if (!input.existingReportPaths?.markdown) {
    const changedFiles = input.changedFiles.length > 0
      ? input.changedFiles.map((file) => `- \`${file}\``)
      : ["No changed files detected."];
    const checks = compactVerification.length > 0
      ? compactVerification.map((check) =>
          `- ${check.passed ? "PASS" : "FAIL"} \`${check.command}\``)
      : ["No verification commands were run."];
    const markdown = [
      "# Codex-MiMo Job Report",
      "",
      `Job: \`${input.job.id}\``,
      `Kind: \`${input.job.kind}\``,
      `Status: \`${input.status}\``,
      `Summary: ${summary}`,
      "",
      "## Changed Files",
      "",
      ...changedFiles,
      "",
      "## Verification",
      "",
      ...checks,
      "",
      "## Artifact Paths",
      "",
      ...(result ? [`- Result: \`${result}\``] : []),
      ...(plan ? [`- Plan: \`${plan}\``] : []),
      ...(verification ? [`- Verification: \`${verification}\``] : []),
      ...(diffPath ? [`- Diff: \`${diffPath}\``] : []),
      ""
    ].join("\n");
    fs.writeFileSync(storedReportPaths.markdown!, markdown, "utf8");
  }

  return storedReportPaths;
}

function normalizeReportPaths(reportPaths: JobReportPaths): JobReportPaths {
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
