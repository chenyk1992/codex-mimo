import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeJobArtifacts } from "../../../src/core/job-artifacts.js";
import type { JobRecord } from "../../../src/core/jobs.js";

const roots: string[] = [];

function root(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-artifacts-"));
  roots.push(cwd);
  return cwd;
}

function planJob(cwd: string): JobRecord {
  return {
    id: "plan-1",
    kind: "plan",
    cwd,
    task: "private objective",
    request: { privatePrompt: "PRIVATE_PROMPT" },
    status: "completed",
    processIdentity: null,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:01.000Z",
    changedFiles: [],
    verification: [],
    logFile: path.join(cwd, "job.log"),
    eventsFile: path.join(cwd, "events.jsonl"),
    signalsFile: path.join(cwd, "signals.jsonl"),
    notificationOutboxFile: path.join(cwd, "notifications.jsonl")
  };
}

afterEach(() => {
  for (const cwd of roots.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

describe("writeJobArtifacts", () => {
  it("separates structural reports from complete semantic and verification artifacts", () => {
    const cwd = root();
    const finalText = "# Plan\n\nComplete plan body with token=artifact-secret.";
    const safeFinalText = "# Plan\n\nComplete plan body with token=[REDACTED]";
    const stdout = "TEST_STDOUT token=verification-secret";
    const safeStdout = "TEST_STDOUT token=[REDACTED]";
    const diff = "diff --git a/src/a.ts b/src/a.ts\n+token=diff-secret";
    const paths = writeJobArtifacts({
      job: planJob(cwd),
      status: "completed",
      changedFiles: [],
      verification: [{
        command: "npm test",
        exitCode: 0,
        passed: true,
        durationMs: 12,
        stdout,
        stderr: ""
      }],
      finalText,
      diff,
      plan: true
    });

    expect(fs.readFileSync(paths.result!, "utf8")).toBe(safeFinalText);
    expect(fs.readFileSync(paths.plan!, "utf8")).toBe(safeFinalText);
    expect(fs.readFileSync(paths.verification!, "utf8")).toContain(safeStdout);
    expect(fs.readFileSync(paths.verification!, "utf8")).not.toContain("verification-secret");
    expect(fs.readFileSync(paths.diff!, "utf8")).toContain("token=[REDACTED]");
    expect(fs.readFileSync(paths.diff!, "utf8")).not.toContain("diff-secret");

    const structuralJson = fs.readFileSync(paths.json!, "utf8");
    const structuralMarkdown = fs.readFileSync(paths.markdown!, "utf8");
    for (const structural of [structuralJson, structuralMarkdown]) {
      expect(structural).not.toContain(finalText);
      expect(structural).not.toContain(stdout);
      expect(structural).not.toContain("diff --git");
      expect(structural).not.toContain("PRIVATE_PROMPT");
    }
    expect(JSON.parse(structuralJson).reportPaths).toMatchObject({
      result: paths.result,
      plan: paths.plan,
      verification: paths.verification
    });
  });
});
