import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FULL_ARTIFACT_MAX_BYTES,
  readFinalJobOutput,
  readJobDiagnostics,
  readKeyVerificationError,
  readSavedJobOutput,
  readTextArtifact,
  redactDiagnosticText,
  summarizeJobOutput
} from "../../../src/core/job-output.js";
import type { JobRecord } from "../../../src/core/jobs.js";

const tempDirs: string[] = [];

function tempFile(contents?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-job-output-"));
  tempDirs.push(dir);
  const file = path.join(dir, "events.jsonl");
  if (contents !== undefined) fs.writeFileSync(file, contents, "utf8");
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("readFinalJobOutput", () => {
  it("reads top-level text events", () => {
    const file = tempFile(`${JSON.stringify({ type: "text", text: "first" })}\n`);
    expect(readFinalJobOutput(file)).toBe("first");
  });

  it("reads nested MiMo part.text events", () => {
    const file = tempFile(`${JSON.stringify({ type: "text", part: { text: "final plan" } })}\n`);
    expect(readFinalJobOutput(file)).toBe("final plan");
  });

  it("returns the last non-empty message", () => {
    const file = tempFile([
      JSON.stringify({ type: "text", text: "first" }),
      JSON.stringify({ type: "text", text: "   " }),
      JSON.stringify({ type: "text", part: { text: "final plan" } })
    ].join("\n"));
    expect(readFinalJobOutput(file)).toBe("final plan");
  });

  it("trims trailing whitespace but preserves internal Markdown and newlines", () => {
    const body = "# Plan\n\nBody with **bold**\nand a list:\n- one\n- two";
    const file = tempFile(`${JSON.stringify({ type: "text", part: { text: `${body}\n\n  ` } })}\n`);
    expect(readFinalJobOutput(file)).toBe(body);
  });

  it("ignores malformed JSONL lines when a later valid message exists", () => {
    const file = tempFile([
      "{not-json",
      JSON.stringify({ type: "text", text: "kept" }),
      "also broken"
    ].join("\n"));
    expect(readFinalJobOutput(file)).toBe("kept");
  });

  it("returns undefined for a missing file", () => {
    expect(readFinalJobOutput(path.join(os.tmpdir(), "codex-mimo-missing-events.jsonl"))).toBeUndefined();
  });

  it("returns undefined for an empty file", () => {
    expect(readFinalJobOutput(tempFile(""))).toBeUndefined();
  });

  it("returns undefined when the path is unreadable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-job-output-dir-"));
    tempDirs.push(dir);
    expect(readFinalJobOutput(dir)).toBeUndefined();
  });
});

describe("job output helpers", () => {
  it("extracts a bounded semantic summary after a Markdown heading", () => {
    const output = "# Complete plan\n\nImplement the callback in three focused steps.\n\n## Details\n...";
    expect(summarizeJobOutput(output)).toBe("Implement the callback in three focused steps.");
  });

  it("prefers an explicit final summary section", () => {
    const output = "# Plan\n\nLong introduction.\n\n## Summary\n\nUse the compact delivery path.";
    expect(summarizeJobOutput(output)).toBe("Use the compact delivery path.");
  });

  it("redacts credentials before returning a semantic summary", () => {
    expect(summarizeJobOutput("# Plan\n\nUse token=private for the request."))
      .toBe("Use token=[REDACTED] for the request.");
  });

  it("caps semantic summaries at 500 characters", () => {
    expect(summarizeJobOutput("x".repeat(700))).toHaveLength(500);
  });

  it("reads an optional text artifact without throwing", () => {
    const file = tempFile("artifact body");
    expect(readTextArtifact(file)).toBe("artifact body");
    expect(readTextArtifact(`${file}.missing`)).toBeUndefined();
  });

  it("prefers the saved result artifact over reparsing legacy events", () => {
    const resultFile = tempFile("saved result");
    expect(readSavedJobOutput({
      reportPaths: { result: resultFile },
      eventsFile: `${resultFile}.missing`
    } as JobRecord)).toBe("saved result");
  });

  it("redacts recognized credentials from explicit full diagnostics", () => {
    expect(redactDiagnosticText(
      "Authorization: Bearer secret-token token=abc123 --password hunter2 " +
        "https://example.test/?api_key=url-secret ghp_abcdefghijklmnopqrstuvwxyz"
    )).toBe(
      "Authorization: Bearer [REDACTED] token=[REDACTED] --password [REDACTED] " +
        "https://example.test/?api_key=[REDACTED] [REDACTED]"
    );
  });

  it("returns artifact_too_large with the exact path instead of truncating", () => {
    const resultFile = tempFile("x".repeat(FULL_ARTIFACT_MAX_BYTES + 1));
    const job = {
      id: "plan-legacy",
      kind: "plan",
      cwd: path.dirname(resultFile),
      task: "plan",
      request: {},
      status: "completed",
      processIdentity: null,
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:01.000Z",
      changedFiles: [],
      verification: [],
      reportPaths: { result: resultFile },
      logFile: `${resultFile}.log`,
      eventsFile: `${resultFile}.events`,
      signalsFile: `${resultFile}.signals`,
      notificationOutboxFile: `${resultFile}.outbox`
    } satisfies JobRecord;

    const diagnostics = readJobDiagnostics(job);
    expect(diagnostics).not.toHaveProperty("output");
    expect(diagnostics.artifactErrors).toEqual([{
      code: "artifact_too_large",
      artifact: "output",
      path: resultFile,
      bytes: FULL_ARTIFACT_MAX_BYTES + 1
    }]);
  });

  it("extracts one bounded and redacted standard verification error", () => {
    const file = tempFile(JSON.stringify([{
      command: "npm test",
      exitCode: 1,
      passed: false,
      stdout: "",
      stderr: `token=private ${"failure ".repeat(100)}`
    }]));
    const excerpt = readKeyVerificationError(file)!;
    expect(excerpt).toContain("token=[REDACTED]");
    expect(excerpt).toHaveLength(500);
  });
});
