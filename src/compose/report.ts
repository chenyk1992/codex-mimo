import fs from "node:fs";
import path from "node:path";
import type { NormalizedMimoEvent } from "./events.js";
import type { ComposeWorkflowName } from "./workflow.js";
import type { VerificationResult } from "./verify.js";

export interface ComposeReport {
  id: string;
  createdAt: string;
  workflow: ComposeWorkflowName;
  cwd: string;
  task: string;
  mimoArgs: string[];
  requestedSkills: string[];
  status: "passed" | "failed" | "needs_review";
  events: NormalizedMimoEvent[];
  changedFiles: string[];
  diffStat: string;
  verification: VerificationResult[];
  reviewText?: string;
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

  return [
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
    "",
    "## Changed Files",
    "",
    changedFiles.join("\n"),
    "",
    "## Diff Stat",
    "",
    "```text",
    report.diffStat || "No diff stat.",
    "```",
    "",
    "## Verification",
    "",
    verificationLines.join("\n"),
    "",
    "## Review",
    "",
    report.reviewText || "No review text was captured.",
    "",
    "## Report Files",
    "",
    `- JSON: \`${report.reportPaths.json}\``,
    `- Markdown: \`${report.reportPaths.markdown}\``,
    `- Events JSONL: \`${report.reportPaths.eventsJsonl}\``,
    ""
  ].join("\n");
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
