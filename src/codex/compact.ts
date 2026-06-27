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
  planText?: string;
  error?: string;
  sessionId?: string | null;
  callback?: {
    outcome: "completed" | "error" | "cancelled" | "missing" | "unknown";
    sessionId?: string | null;
    receivedAt?: string;
    error?: string;
  };
  resumeHint?: {
    tool: "mimo_resume";
    session: string;
  };
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
    planText: report.planText,
    error: report.error,
    sessionId: report.sessionId ?? null,
    ...(compactCallback(report) ? { callback: compactCallback(report) } : {}),
    ...(report.sessionId ? { resumeHint: { tool: "mimo_resume" as const, session: report.sessionId } } : {}),
    reportPaths: report.reportPaths
  };
}

function compactCallback(report: ComposeReport): CompactComposeReport["callback"] | undefined {
  if (report.callback) {
    return {
      outcome: report.callback.outcome ?? "unknown",
      sessionId: report.callback.sessionId ?? null,
      receivedAt: report.callback.receivedAt,
      ...(report.callback.error ? { error: report.callback.error } : {})
    };
  }
  if (report.callbackTimedOut) return { outcome: "missing" };
  return undefined;
}
