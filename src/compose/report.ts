import fs from "node:fs";
import path from "node:path";
import type { NormalizedMimoEvent } from "./events.js";
import type { ComposeWorkflowName } from "./workflow.js";
import type { VerificationResult } from "./verify.js";
import type { GitStatusSnapshot } from "../git/status.js";

export interface ComposeReport {
  id: string;
  createdAt: string;
  workflow: ComposeWorkflowName;
  cwd: string;
  task: string;
  mimoArgs: string[];
  requestedSkills: string[];
  status: "passed" | "failed" | "needs_review" | "timeout";
  events: NormalizedMimoEvent[];
  changedFiles: string[];
  diffStat: string;
  diffPath?: string;
  terminationReason?: "process_timeout" | "host_abort" | "user_cancelled";
  gitStatusBefore?: GitStatusSnapshot;
  gitStatusAfter?: GitStatusSnapshot;
  verification: VerificationResult[];
  reviewText?: string;
  planText?: string;
  error?: string;
  reportPaths: {
    json: string;
    markdown: string;
    eventsJsonl: string;
  };
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
    "",
    "## Task",
    "",
    report.task,
    "",
    "## Requested Compose Skills",
    "",
    report.requestedSkills.map((skill) => `- \`${skill}\``).join("\n"),
    "",
    "## MiMoCode Command",
    "",
    "```bash",
    `mimo ${report.mimoArgs.join(" ")}`,
    "```",
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
    "",
    "## Review",
    "",
    report.reviewText || "No review text was captured.",
    ""
  );

  if (report.planText) {
    lines.push(
      "## Plan",
      "",
      report.planText,
      ""
    );
  }

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
