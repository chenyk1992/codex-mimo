import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseDiffReviewVerdict,
  runReadOnlyDiffReview
} from "../../../src/compose/diff-review.js";
import { diffReviewPrompt } from "../../../src/core/prompt.js";
import type { GitStatusSnapshot } from "../../../src/git/diff.js";
import type { StreamingRunResult } from "../../../src/mimo/streaming-runner.js";

const cleanStatus: GitStatusSnapshot = { short: "", dirty: false, fingerprints: {} };

function jsonLine(text: string): string {
  return JSON.stringify({ type: "text", text, sessionID: "sess-1" });
}

function makeRunResult(finalText: string, exitCode = 0): StreamingRunResult {
  return {
    stdout: `${jsonLine(finalText)}\n`,
    stderr: "",
    exitCode,
    pid: 123
  };
}

describe("parseDiffReviewVerdict", () => {
  it("parses a bare JSON verdict envelope", () => {
    const verdict = parseDiffReviewVerdict(
      JSON.stringify({
        verdict: "pass",
        findings: [{ severity: "info", message: "Looks good." }]
      })
    );

    expect(verdict).toEqual({
      verdict: "pass",
      findings: [{ severity: "info", message: "Looks good." }]
    });
  });

  it("parses a fenced JSON verdict envelope", () => {
    const verdict = parseDiffReviewVerdict([
      "Review complete.",
      "```json",
      JSON.stringify({
        verdict: "fail",
        findings: [{ severity: "blocker", message: "Null deref", path: "src/a.ts" }]
      }),
      "```"
    ].join("\n"));

    expect(verdict).toEqual({
      verdict: "fail",
      findings: [{ severity: "blocker", message: "Null deref", path: "src/a.ts" }]
    });
  });

  it("returns null for malformed verdict JSON", () => {
    expect(parseDiffReviewVerdict("not json")).toBeNull();
    expect(parseDiffReviewVerdict(JSON.stringify({ verdict: "maybe", findings: [] }))).toBeNull();
    expect(parseDiffReviewVerdict(JSON.stringify({ verdict: "pass" }))).toBeNull();
    expect(parseDiffReviewVerdict(JSON.stringify({
      verdict: "pass",
      findings: [{ severity: "critical", message: "bad severity" }]
    }))).toBeNull();
  });
});

describe("diffReviewPrompt", () => {
  it("requires a JSON verdict envelope and references the diff path", () => {
    const prompt = diffReviewPrompt(".codex-mimo/diffs/job-1.diff");

    expect(prompt).toMatch(/^Objective:/);
    expect(prompt).toContain("@.codex-mimo/diffs/job-1.diff");
    expect(prompt).toContain('"verdict": "pass"');
    expect(prompt).toContain("Do not edit files.");
  });
});

describe("runReadOnlyDiffReview", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function setupDiff(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-review-"));
    const diffPath = path.join(tmpDir, ".codex-mimo", "diffs", "job-1.diff");
    fs.mkdirSync(path.dirname(diffPath), { recursive: true });
    fs.writeFileSync(diffPath, content, "utf8");
    return diffPath;
  }

  it("returns not_applicable when the diff is missing or empty", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-review-"));

    const missing = await runReadOnlyDiffReview({
      cwd: tmpDir,
      diffPath: ".codex-mimo/diffs/missing.diff"
    });
    expect(missing).toEqual({
      stage: "diff_check",
      outcome: "not_applicable",
      reason: "no_diff"
    });

    const emptyPath = setupDiff("   \n");
    const empty = await runReadOnlyDiffReview({
      cwd: tmpDir,
      diffPath: path.relative(tmpDir, emptyPath)
    });
    expect(empty.outcome).toBe("not_applicable");
    expect(empty.reason).toBe("no_diff");
  });

  it("passes when the verdict passes with only minor or info findings", async () => {
    const diffPath = setupDiff("diff --git a/src/a.ts b/src/a.ts\n+change");
    const runMimo = vi.fn(async () => makeRunResult(JSON.stringify({
      verdict: "pass",
      findings: [{ severity: "minor", message: "Consider renaming helper." }]
    })));

    const result = await runReadOnlyDiffReview({
      cwd: tmpDir,
      diffPath: path.relative(tmpDir, diffPath),
      sessionId: "sess-parent",
      runMimo,
      captureStatus: vi.fn(async () => cleanStatus)
    });

    expect(result.outcome).toBe("passed");
    expect(JSON.parse(result.stdout!)).toEqual({
      warnings: [{ severity: "minor", message: "Consider renaming helper." }]
    });
    expect(runMimo).toHaveBeenCalledWith(
      tmpDir,
      expect.arrayContaining([
        "run",
        "--format",
        "json",
        "--agent",
        "codex-mimo-readonly",
        "--session",
        "sess-parent"
      ]),
      expect.any(Object)
    );
  });

  it("fails with delivery_contract_missing when final text has no valid verdict", async () => {
    const diffPath = setupDiff("diff --git a/src/a.ts b/src/a.ts\n+change");
    const runMimo = vi.fn(async () => makeRunResult("Review looks fine, no JSON here."));

    const result = await runReadOnlyDiffReview({
      cwd: tmpDir,
      diffPath: path.relative(tmpDir, diffPath),
      runMimo,
      captureStatus: vi.fn(async () => cleanStatus)
    });

    expect(result).toMatchObject({
      stage: "diff_check",
      outcome: "failed",
      reason: "delivery_contract_missing"
    });
  });

  it("fails when blocker or major findings are present", async () => {
    const diffPath = setupDiff("diff --git a/src/a.ts b/src/a.ts\n+change");
    const runMimo = vi.fn(async () => makeRunResult(JSON.stringify({
      verdict: "fail",
      findings: [{ severity: "major", message: "Missing test coverage for callback." }]
    })));

    const result = await runReadOnlyDiffReview({
      cwd: tmpDir,
      diffPath: path.relative(tmpDir, diffPath),
      runMimo,
      captureStatus: vi.fn(async () => cleanStatus)
    });

    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(/Missing test coverage/);
  });

  it("fails when the read-only review modifies the workspace", async () => {
    const diffPath = setupDiff("diff --git a/src/a.ts b/src/a.ts\n+change");
    const runMimo = vi.fn(async () => makeRunResult(JSON.stringify({ verdict: "pass", findings: [] })));
    const captureStatus = vi
      .fn()
      .mockResolvedValueOnce({ short: "", dirty: false })
      .mockResolvedValueOnce({
        short: " M src/a.ts",
        dirty: true
      });

    const result = await runReadOnlyDiffReview({
      cwd: tmpDir,
      diffPath: path.relative(tmpDir, diffPath),
      runMimo,
      captureStatus
    });

    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(/modified files/);
  });

  it("passes with warnings when verdict is fail but findings are only minor or info", async () => {
    const diffPath = setupDiff("diff --git a/src/a.ts b/src/a.ts\n+change");
    const runMimo = vi.fn(async () => makeRunResult(JSON.stringify({
      verdict: "fail",
      findings: [{ severity: "info", message: "Style nit only." }]
    })));

    const result = await runReadOnlyDiffReview({
      cwd: tmpDir,
      diffPath: path.relative(tmpDir, diffPath),
      runMimo,
      captureStatus: vi.fn(async () => cleanStatus)
    });

    expect(result.outcome).toBe("passed");
    expect(JSON.parse(result.stdout!)).toEqual({
      warnings: [{ severity: "info", message: "Style nit only." }]
    });
  });
});
