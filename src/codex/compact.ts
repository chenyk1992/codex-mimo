import type { ComposeReport } from "../compose/report.js";
import { summarizeEvents } from "../compose/events.js";

export interface CompactComposeReport {
  id: string;
  createdAt: string;
  workflow: ComposeReport["workflow"];
  status: ComposeReport["status"];
  summary: string;
  changedFiles: string[];
  diffStat: string;
  diffPath?: string;
  eventSummary: ReturnType<typeof summarizeEvents>;
  verification: Array<{
    command: string;
    exitCode: number | null;
    passed: boolean;
    durationMs: number;
  }>;
  reviewText?: string;
  error?: string;
  reportPaths: ComposeReport["reportPaths"];
}

export function compactComposeReportForCodex(report: ComposeReport): CompactComposeReport {
  const passedVerification = report.verification.filter((result) => result.passed).length;
  const verificationSummary = report.verification.length === 0
    ? "no verification commands run"
    : `${passedVerification}/${report.verification.length} verification commands passed`;
  const changedFileLabel = report.changedFiles.length === 1 ? "changed file" : "changed files";

  return {
    id: report.id,
    createdAt: report.createdAt,
    workflow: report.workflow,
    status: report.status,
    summary: `${report.workflow} ${report.status}; ${report.changedFiles.length} ${changedFileLabel}; ${verificationSummary}. Full JSON, Markdown, and event logs are persisted in reportPaths.`,
    changedFiles: report.changedFiles,
    diffStat: report.diffStat,
    diffPath: report.diffPath,
    eventSummary: summarizeEvents(report.events),
    verification: report.verification.map((result) => ({
      command: result.command,
      exitCode: result.exitCode,
      passed: result.passed,
      durationMs: result.durationMs
    })),
    reviewText: report.reviewText,
    error: report.error,
    reportPaths: report.reportPaths
  };
}
