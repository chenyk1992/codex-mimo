import fs from "node:fs";
import path from "node:path";
import type { NormalizedMimoEvent } from "./events.js";
import type { ComposeWorkflowName } from "./workflow.js";
import type { VerificationResult } from "./verify.js";
import type { GitDiffSnapshot, GitHeadSnapshot, GitStatusSnapshot } from "../git/diff.js";
import type { ExecutionCallbackSummary } from "../core/jobs.js";
import type { TerminationReason } from "../mimo/streaming-runner.js";
import { publicProgressSummary } from "../core/public-summary.js";

export interface ComposeReport {
  id: string;
  createdAt: string;
  workflow: ComposeWorkflowName;
  cwd: string;
  requestedSkills: string[];
  status: "passed" | "failed" | "needs_review" | "timeout";
  events: ComposeReportEvent[];
  changedFiles: string[];
  diffStat: string;
  diffPath?: string;
  terminationReason?: TerminationReason;
  sessionId?: string | null;
  executionCallback?: ExecutionCallbackSummary;
  gitStatusBefore?: GitStatusSnapshot;
  gitStatusAfter?: GitStatusSnapshot;
  gitHeadBefore?: GitHeadSnapshot;
  gitHeadAfter?: GitHeadSnapshot;
  gitCommits?: string[];
  verification: VerificationResult[];
  error?: string;
  reportPaths: {
    json: string;
    markdown: string;
    eventsJsonl: string;
  };
}

export interface CreateComposeReportInput {
  id: string;
  createdAt: string;
  workflow: ComposeWorkflowName;
  cwd: string;
  requestedSkills: string[];
  status: ComposeReport["status"];
  events: NormalizedMimoEvent[];
  diff: GitDiffSnapshot;
  terminationReason?: TerminationReason;
  sessionId?: string | null;
  executionCallback?: ExecutionCallbackSummary;
  gitStatusBefore?: GitStatusSnapshot;
  gitStatusAfter?: GitStatusSnapshot;
  gitHeadBefore?: GitHeadSnapshot;
  gitHeadAfter?: GitHeadSnapshot;
  gitCommits?: string[];
  verification: VerificationResult[];
  error?: string;
  reportDir: string;
  eventsDir: string;
  diffsDir: string;
}

export function createComposeReport(input: CreateComposeReportInput): ComposeReport {
  const diffPath = input.diff.diff ? path.join(input.diffsDir, `${input.id}.diff`) : undefined;
  if (diffPath) {
    fs.mkdirSync(input.diffsDir, { recursive: true });
    fs.writeFileSync(diffPath, input.diff.diff, "utf-8");
  }

  return {
    id: input.id,
    createdAt: input.createdAt,
    workflow: input.workflow,
    cwd: input.cwd,
    requestedSkills: input.requestedSkills,
    status: input.status,
    events: input.events.map(toComposeReportEvent),
    changedFiles: input.diff.changedFiles,
    diffStat: input.diff.diffStat,
    diffPath,
    terminationReason: input.terminationReason,
    sessionId: input.sessionId,
    executionCallback: input.executionCallback
      ? {
          ...input.executionCallback,
          ...(input.executionCallback.error !== undefined
            ? { error: publicProgressSummary({
                type: "callback",
                outcome: input.executionCallback.outcome
              }) }
            : {})
        }
      : undefined,
    gitStatusBefore: input.gitStatusBefore,
    gitStatusAfter: input.gitStatusAfter,
    gitHeadBefore: input.gitHeadBefore,
    gitHeadAfter: input.gitHeadAfter,
    gitCommits: input.gitCommits,
    verification: input.verification,
    error: input.error
      ? publicProgressSummary({
          type: "job",
          status: input.status === "timeout"
            ? "timeout"
            : input.status === "failed"
              ? "failed"
              : "completed"
        })
      : undefined,
    reportPaths: {
      json: path.join(input.reportDir, `${input.id}.json`),
      markdown: path.join(input.reportDir, `${input.id}.md`),
      eventsJsonl: path.join(input.eventsDir, `${input.id}.jsonl`)
    }
  };
}

export interface ComposeReportEvent {
  type: NormalizedMimoEvent["type"];
  progressKind?: NormalizedMimoEvent["progressKind"];
  usage?: NormalizedMimoEvent["usage"];
}

export function renderMarkdownReport(report: ComposeReport): string {
  const verificationLines = report.verification.length === 0
    ? ["No verification commands were run."]
    : report.verification.map((result) =>
        `- ${result.passed ? "PASS" : "FAIL"} \`${result.command}\` exit=${result.exitCode ?? "null"} duration=${result.durationMs}ms`
      );

  const changedFiles = report.changedFiles.length === 0
    ? ["No changed files detected."]
    : report.changedFiles.map((file) => `- \`${file}\``);

  const lines = [
    "# Codex-MiMo Compose Report",
    "",
    `Run ID: \`${report.id}\``,
    `Created: \`${report.createdAt}\``,
    `Workflow: \`${report.workflow}\``,
    `Status: \`${report.status}\``,
    `CWD: \`${report.cwd}\``,
    ...(report.sessionId ? [`Session ID: \`${report.sessionId}\``] : []),
    "",
    "## Requested Compose Skills",
    "",
    report.requestedSkills.map((skill) => `- \`${skill}\``).join("\n"),
    "",
    ""
  ];

  if (report.gitStatusBefore) {
    lines.push(
      "## Git Status (Before)",
      "",
      "```text",
      report.gitStatusBefore.short || "(clean)",
      "```",
      ""
    );
  }

  if (report.gitStatusAfter) {
    lines.push(
      "## Git Status (After)",
      "",
      "```text",
      report.gitStatusAfter.short || "(clean)",
      "```",
      ""
    );
  }

  if (report.gitHeadBefore || report.gitHeadAfter) {
    lines.push(
      "## Git HEAD",
      "",
      `Before: \`${formatGitHead(report.gitHeadBefore)}\``,
      `After: \`${formatGitHead(report.gitHeadAfter)}\``,
      ""
    );
  }

  if (report.gitCommits && report.gitCommits.length > 0) {
    lines.push(
      "## Git Commits Created",
      "",
      report.gitCommits.map((commit) => `- \`${commit}\``).join("\n"),
      ""
    );
  }

  if (report.executionCallback) {
    lines.push(
      "## Execution Callback",
      ""
    );
    if (report.executionCallback.outcome !== "missing") {
      lines.push(
        `Outcome: \`${report.executionCallback.outcome}\``,
        `Invocation ID: \`${report.executionCallback.invocationId}\``,
        ...(report.executionCallback.sessionId ? [`Session ID: \`${report.executionCallback.sessionId}\``] : []),
        ...(report.executionCallback.receivedAt ? [`Received At: \`${report.executionCallback.receivedAt}\``] : []),
        ...(report.executionCallback.error ? [`Error: \`${report.executionCallback.error}\``] : []),
        ""
      );
    } else {
      lines.push(
        "No session.post callback was received before the callback wait timed out.",
        ""
      );
    }
  }

  lines.push(
    "## Changed Files",
    "",
    changedFiles.join("\n"),
    "",
    "## Diff Stat",
    "",
    "```text",
    report.diffStat || "No diff stat.",
    "```",
    ""
  );

  const eventCounts = countReportEvents(report.events);
  lines.push(
    "## Event Summary",
    "",
    `Messages: ${eventCounts.message}`,
    `Tools: ${eventCounts.tool}`,
    `Diffs: ${eventCounts.diff}`,
    `Errors: ${eventCounts.error}`,
    `Progress: ${eventCounts.progress}`,
    `Usage: ${eventCounts.usage}`,
    `Raw: ${eventCounts.raw}`,
    ""
  );

  if (report.diffPath) {
    lines.push(
      "## Full Diff",
      "",
      `Full diff saved to: \`${report.diffPath}\``,
      ""
    );
  }

  lines.push(
    "## Verification",
    "",
    verificationLines.join("\n"),
    ""
  );

  if (report.terminationReason) {
    lines.push(
      "## Termination",
      "",
      `Reason: \`${report.terminationReason}\``,
      ""
    );
  }

  if (report.error) {
    lines.push(
      "## Error",
      "",
      "```text",
      report.error,
      "```",
      ""
    );
  }

  lines.push(
    "## Report Files",
    "",
    `- JSON: \`${report.reportPaths.json}\``,
    `- Markdown: \`${report.reportPaths.markdown}\``,
    `- Events JSONL: \`${report.reportPaths.eventsJsonl}\``,
    ""
  );

  return lines.join("\n");
}

function toComposeReportEvent(event: NormalizedMimoEvent): ComposeReportEvent {
  return {
    type: event.type,
    ...(event.progressKind ? { progressKind: event.progressKind } : {}),
    ...(event.usage ? { usage: { ...event.usage } } : {})
  };
}

function countReportEvents(
  events: readonly ComposeReportEvent[]
): Record<ComposeReportEvent["type"], number> {
  const counts: Record<ComposeReportEvent["type"], number> = {
    message: 0,
    tool: 0,
    diff: 0,
    usage: 0,
    error: 0,
    progress: 0,
    raw: 0
  };
  for (const event of events) counts[event.type] += 1;
  return counts;
}

function formatGitHead(head?: GitHeadSnapshot): string {
  if (!head) return "unknown";
  return [head.short, head.subject].filter(Boolean).join(" ");
}

export function writeComposeReport(report: ComposeReport): void {
  fs.mkdirSync(path.dirname(report.reportPaths.json), { recursive: true });
  fs.mkdirSync(path.dirname(report.reportPaths.markdown), { recursive: true });
  fs.mkdirSync(path.dirname(report.reportPaths.eventsJsonl), { recursive: true });

  fs.writeFileSync(report.reportPaths.json, JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(report.reportPaths.markdown, renderMarkdownReport(report), "utf-8");
  fs.writeFileSync(
    report.reportPaths.eventsJsonl,
    report.events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf-8"
  );
}
