import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPACT_RESULT_MAX_BYTES,
  renderCompactJobResult,
  renderCompactJobStatus,
  renderFullJobResult,
  renderJobResult,
  renderJobStatus
} from "../../src/core/job-render.js";
import { writeJobChainAtomic } from "../../src/core/job-chain.js";
import type { JobRecord } from "../../src/core/jobs.js";

function job(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "implement-1",
    kind: "implement",
    cwd: "E:/project/app",
    task: "Implement login throttling",
    request: { cwd: "E:/project/app", task: "Implement login throttling", allowWrite: true },
    status: "running",
    phase: "verifying",
    pid: 123,
    processIdentity: "win32:123",
    sessionId: "ses_123",
    parentJobId: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    startedAt: "2026-07-16T00:00:01.000Z",
    updatedAt: "2026-07-16T00:00:02.000Z",
    changedFiles: ["src/login.ts"],
    verification: [],
    summary: "Running npm test.",
    notificationTarget: { type: "codex", threadId: "thread-1" },
    logFile: "PRIVATE PROMPT job.log",
    eventsFile: "PRIVATE RAW events.jsonl",
    signalsFile: "PRIVATE SIGNALS signals.jsonl",
    notificationOutboxFile: "PRIVATE OUTBOX notifications.jsonl",
    ...patch
  };
}

describe("compact job rendering", () => {
  it("renders the heartbeat as one short state", () => {
    expect(renderCompactJobStatus(job())).toEqual({ status: "running" });
    expect(renderCompactJobStatus(job({
      status: "completed",
      phase: undefined
    }))).toEqual({ status: "completed", resultAvailable: true });
    expect(renderCompactJobStatus(job({
      kind: "compose",
      status: "completed",
      phase: undefined,
      assessment: "needs_review"
    }))).toEqual({
      status: "completed",
      resultAvailable: true,
      assessment: "needs_review"
    });
  });

  it("maps acceptance stages and failure details into compact results", () => {
    const result = renderCompactJobResult(job({
      status: "failed",
      phase: undefined,
      errorCode: "build_failed",
      acceptance: {
        stages: [
          { stage: "build", outcome: "failed", command: "npm run build" },
          { stage: "test", outcome: "pending" },
          { stage: "diff_check", outcome: "pending" }
        ],
        failedStage: "build",
        failedCommand: "npm run build",
        suggestion: "Fix the first TypeScript error at src/a.ts:42, then rerun npm run build."
      },
      verification: [{ command: "npm run build", exitCode: 1, passed: false }],
      reportPaths: { markdown: "report.md" }
    }));

    expect(result.tests).toEqual([{
      stage: "build",
      command: "npm run build",
      outcome: "failed"
    }]);
    expect(result.failure).toMatchObject({
      code: "build_failed",
      failedStage: "build",
      failedCommand: "npm run build",
      suggestion: "Fix the first TypeScript error at src/a.ts:42, then rerun npm run build."
    });
  });

  it("keeps slice_failed compatible while exposing the actionable leaf cause", () => {
    const result = renderCompactJobResult(job({
      status: "failed",
      phase: undefined,
      errorCode: "slice_failed",
      acceptance: {
        stages: [{ stage: "test", outcome: "failed", command: "npm test -- focused" }],
        failedStage: "test",
        failedCommand: "npm test -- focused",
        failedTests: ["focused"],
        suggestion: "Fix the failing focused test."
      },
      failureCauses: [{
        code: "tests_failed",
        stage: "test",
        command: "npm test -- focused",
        suggestion: "Fix the failing focused test."
      }]
    }));

    expect(result.failure).toMatchObject({
      code: "slice_failed",
      failedStage: "test",
      failedCommand: "npm test -- focused",
      failedTests: ["focused"],
      suggestion: "Fix the failing focused test.",
      causes: [{
        code: "tests_failed",
        stage: "test"
      }]
    });
  });

  it("exposes stalled worker_lost as a compact failure", () => {
    const result = renderCompactJobResult(job({
      status: "stalled",
      phase: undefined,
      errorCode: "worker_lost",
      summary: "MiMoCode job stalled without effective progress."
    }));

    expect(result.failure).toMatchObject({
      code: "worker_lost"
    });
  });

  it("removes generic, duplicate, and unknown-path causes from compact failures", () => {
    const result = renderCompactJobResult(job({
      status: "stalled",
      phase: undefined,
      errorCode: "worker_lost",
      failureCauses: [
        { code: "diff_check_failed", stage: "diff_check", command: "git diff --check" },
        { code: "verification_failed", stage: "test" },
        {
          code: "write_scope_violation",
          stage: "scope_check",
          suggestion: "Blocked path: unknown"
        },
        { code: "diff_check_failed", stage: "diff_check", command: "git diff --check" }
      ]
    }));

    expect(result.failure?.causes).toEqual([
      { code: "diff_check_failed", stage: "diff_check", command: "git diff --check" }
    ]);
  });

  it("omits output and operator metadata from compact implementation results", () => {
    const result = renderCompactJobResult(job({
      status: "completed",
      phase: undefined,
      reportPaths: { markdown: "report.md", result: "result.md" },
      verification: [{ command: "npm test --token private", exitCode: 0, passed: true }]
    }), { output: "PRIVATE COMPLETE OUTPUT" });

    expect(result).toEqual({
      status: "completed",
      changedFiles: ["src/login.ts"],
      tests: [{
        stage: "test",
        command: "npm test --token [REDACTED]",
        outcome: "passed"
      }],
      failure: null,
      reportPath: "report.md"
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|session|notification|actions|output/);
  });

  it("exposes partial change detection without treating candidates as verified files", () => {
    const result = renderCompactJobResult(job({
      status: "completed",
      phase: undefined,
      changedFiles: ["src/verified.ts"],
      reconciliation: {
        status: "degraded",
        changeDetection: {
          status: "partial",
          sources: ["git_fingerprint", "scope_manifest"],
          candidates: ["src/candidate.ts"],
          reason: "Git was unavailable for one evidence source."
        },
        warnings: [{
          code: "reconciliation_failed",
          stage: "reconciliation"
        }]
      }
    }));

    expect(result.changedFiles).toEqual(["src/verified.ts"]);
    expect(result.reconciliation).toEqual({
      status: "degraded",
      changeDetection: {
        status: "partial",
        sources: ["git_fingerprint", "scope_manifest"],
        candidates: ["src/candidate.ts"],
        reason: "Git was unavailable for one evidence source."
      },
      warnings: [{
        code: "reconciliation_failed",
        stage: "reconciliation"
      }]
    });
  });

  it("adds only a bounded semantic summary for planning results", () => {
    const result = renderCompactJobResult(job({
      kind: "plan",
      status: "completed",
      phase: undefined,
      changedFiles: [],
      reportPaths: { markdown: "report.md", plan: "plan.md" }
    }), { output: "# Plan\n\nImplement three focused steps." });

    expect(result.summary).toBe("Implement three focused steps.");
    expect(result.reportPath).toBe("plan.md");
    expect(result).not.toHaveProperty("output");
  });

  it("keeps representative English and Chinese compact results within budget", () => {
    for (const output of [
      "# Plan\n\nImplement the smallest safe callback change.",
      "# 方案\n\n按三个小批次实现紧凑回传并保存完整报告。"
    ]) {
      const result = renderCompactJobResult(job({
        kind: "plan",
        status: "failed",
        phase: undefined,
        changedFiles: Array.from({ length: 200 }, (_, index) => `src/very-long-file-${index}.ts`),
        verification: Array.from({ length: 50 }, (_, index) => ({
          command: `npm test -- test-${index}.test.ts`,
          exitCode: index === 0 ? 1 : 0,
          passed: index !== 0
        })),
        errorCode: "verification_failed",
        reportPaths: { markdown: "E:/project/.codex-mimo/reports/plan-1.md" }
      }), { output });
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
        COMPACT_RESULT_MAX_BYTES
      );
      expect(result.failure?.code).toBe("verification_failed");
      expect(result.reportPath).toContain("plan-1.md");
    }
  });

  it("returns full changedFiles and tests at standard and full levels", () => {
    const manyFiles = Array.from({ length: 200 }, (_, index) => `src/file-${index}.ts`);
    const manyTests = Array.from({ length: 50 }, (_, index) => ({
      command: `npm test -- test-${index}.test.ts`,
      exitCode: index === 0 ? 1 : 0,
      passed: index !== 0
    }));
    const completed = job({
      status: "completed",
      phase: undefined,
      changedFiles: manyFiles,
      verification: manyTests
    });

    const compact = renderCompactJobResult(completed);
    expect(compact.changedFiles.length).toBeLessThan(manyFiles.length);
    expect(compact.tests.length).toBeLessThan(manyTests.length);

    const standard = renderJobResult(completed);
    expect(standard.changedFiles).toEqual(manyFiles);
    expect(standard.tests).toHaveLength(manyTests.length);

    const full = renderFullJobResult(completed);
    expect(full.changedFiles).toEqual(manyFiles);
    expect(full.tests).toHaveLength(manyTests.length);
  });

  it("preserves the report path and resume instruction while reducing an attention result", () => {
    const result = renderCompactJobResult(job({
      status: "needs_input",
      phase: undefined,
      changedFiles: Array.from(
        { length: 200 },
        (_, index) => `src/${"nested/".repeat(40)}file-${index}.ts`
      ),
      reportPaths: { markdown: "report.md" }
    }));
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      COMPACT_RESULT_MAX_BYTES
    );
    expect(result.reportPath).toBe("report.md");
    expect(result.attention?.resume).toEqual({
      tool: "mimo_resume",
      jobId: "implement-1"
    });
  });

  it.each([
    ["stalled", "stalled"],
    ["timeout", "timeout"]
  ] as const)("adds resume attention for %s jobs with lastCommand", (status, kind) => {
    const result = renderCompactJobResult(job({
      status,
      phase: undefined,
      lastCommand: "npm test -- src/login.test.ts",
      reportPaths: { markdown: "report.md" }
    }));
    expect(result.attention).toMatchObject({
      kind,
      resume: { tool: "mimo_resume", jobId: "implement-1" },
      lastCommand: "npm test -- src/login.test.ts"
    });
  });

  it("adds resumable_failure attention for allowlisted failed jobs", () => {
    const result = renderCompactJobResult(job({
      status: "failed",
      phase: undefined,
      errorCode: "tests_failed",
      lastCommand: "npm test",
      reportPaths: { markdown: "report.md" }
    }));
    expect(result.attention).toMatchObject({
      kind: "resumable_failure",
      resume: { tool: "mimo_resume", jobId: "implement-1" },
      lastCommand: "npm test"
    });
  });

  it("adds resumable_failure attention for slice_failed root jobs", () => {
    const result = renderCompactJobResult(job({
      status: "failed",
      phase: undefined,
      errorCode: "slice_failed",
      reportPaths: { markdown: "report.md" }
    }));
    expect(result.attention).toMatchObject({
      kind: "resumable_failure",
      resume: { tool: "mimo_resume", jobId: "implement-1" }
    });
  });

  it("omits attention for non-resumable failed jobs", () => {
    const result = renderCompactJobResult(job({
      status: "failed",
      phase: undefined,
      errorCode: "read_only_violation",
      reportPaths: { markdown: "report.md" }
    }));
    expect(result.attention).toBeUndefined();
  });

  it("adds bounded operator identity, timing, phase, and first failed command at standard level", () => {
    const standard = renderJobResult(job({
      status: "failed",
      errorCode: "verification_failed",
      verification: [{ command: "npm test", exitCode: 1, passed: false }]
    }), { output: "COMPLETE OUTPUT MUST NOT APPEAR" });
    expect(standard).toMatchObject({
      jobId: "implement-1",
      phase: "verifying",
      elapsedMs: expect.any(Number),
      keyError: "npm test"
    });
    expect(standard).not.toHaveProperty("output");
  });

  it("freezes elapsed time at completedAt for terminal jobs", () => {
    const terminal = job({
      status: "failed",
      phase: undefined,
      completedAt: "2026-07-16T00:00:05.000Z"
    });

    expect(renderJobStatus(terminal, {
      nowMs: Date.parse("2026-07-16T00:01:00.000Z")
    }).elapsedMs).toBe(4_000);
    expect(renderJobStatus(terminal, {
      nowMs: Date.parse("2026-07-16T01:00:00.000Z")
    }).elapsedMs).toBe(4_000);
  });

  it("fills completedSlices and remainingSlices for chain orchestrator roots", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-render-chain-"));
    try {
      const chainId = "chain-render";
      writeJobChainAtomic(cwd, {
        version: 1,
        chainId,
        rootJobId: "implement-1",
        manifestPath: ".codex-mimo/reports/implement-1.slices.json",
        sliceStates: {
          "slice-1": "completed",
          "slice-2": "pending"
        },
        completedSliceIds: ["slice-1"],
        childJobIds: { "slice-1": "child-1" }
      });
      const standard = renderJobResult(job({
        cwd,
        status: "failed",
        errorCode: "slice_failed",
        chainId,
        parentJobId: null,
        sliceId: null
      }));
      expect(standard.completedSlices).toBe(1);
      expect(standard.remainingSlices).toBe(1);
      expect(renderCompactJobResult(job({
        cwd,
        status: "failed",
        errorCode: "slice_failed",
        chainId,
        parentJobId: null,
        sliceId: null,
        reportPaths: {
          markdown: path.join(cwd, ".codex-mimo", "reports", "implement-child-2.md")
        }
      })).reportJobId).toBe("implement-child-2");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns complete diagnostic artifacts only from the full renderer", () => {
    const completed = job({ status: "completed", phase: undefined });
    const full = renderFullJobResult(completed, {
      output: "# Plan\n\nBody",
      plan: "# Plan\n\nBody",
      verificationDetails: [{
        command: "npm test",
        exitCode: 0,
        passed: true,
        stdout: "ok",
        stderr: ""
      }],
      jobLog: "safe log",
      diff: "diff --git a/a b/a",
      artifactErrors: [{
        code: "artifact_too_large",
        artifact: "diff",
        path: "large.diff",
        bytes: 1_000_001
      }]
    });
    expect(full.output).toBe("# Plan\n\nBody");
    expect(full.plan).toBe("# Plan\n\nBody");
    expect(full.verificationDetails?.[0].stdout).toBe("ok");
    expect(full.jobLog).toBe("safe log");
    expect(full.diff).toContain("diff --git");
    expect(full.artifactErrors).toEqual([{
      code: "artifact_too_large",
      artifact: "diff",
      path: "large.diff",
      bytes: 1_000_001
    }]);
  });

  it("omits assessment for non-compose jobs", () => {
    const result = renderCompactJobResult(job({
      status: "completed",
      phase: undefined,
      reportPaths: { markdown: "report.md" }
    }));
    expect(result).not.toHaveProperty("assessment");
  });

  it("renders assessment for compose jobs with passed assessment", () => {
    const result = renderCompactJobResult(job({
      status: "completed",
      phase: undefined,
      kind: "compose",
      assessment: "passed",
      reportPaths: { markdown: "report.md" }
    }));
    expect(result.assessment).toBe("passed");
  });

  it("renders assessment for compose jobs with needs_review assessment", () => {
    const result = renderCompactJobResult(job({
      status: "completed",
      phase: undefined,
      kind: "compose",
      assessment: "needs_review",
      reportPaths: { markdown: "report.md" }
    }));
    expect(result.assessment).toBe("needs_review");
  });

  it("renders assessment for compose jobs with failed assessment", () => {
    const result = renderCompactJobResult(job({
      status: "completed",
      phase: undefined,
      kind: "compose",
      assessment: "failed",
      reportPaths: { markdown: "report.md" }
    }));
    expect(result.assessment).toBe("failed");
  });
});

describe("standard job rendering", () => {
  it("renders compact running status with only valid actions", () => {
    const result = renderJobStatus(job(), {
      nowMs: Date.parse("2026-07-16T00:00:11.000Z"),
      progress: ["Verification started."],
      notification: { targetType: "codex", status: "delivering", attempts: 2, lastError: "busy" }
    });

    expect(result).toMatchObject({
      jobId: "implement-1",
      kind: "implement",
      parentJobId: null,
      status: "running",
      phase: "verifying",
      elapsedMs: 10_000,
      sessionId: "ses_123",
      summary: "MiMoCode entered the verifying phase.",
      changedFiles: ["src/login.ts"],
      progress: ["MiMoCode entered the verifying phase."],
      notification: {
        targetType: "codex",
        status: "delivering",
        attempts: 2,
        lastError: "Notification delivery requires attention."
      },
      actions: {
        events: "mimo_events",
        wait: "mimo_wait",
        cancel: "mimo_cancel"
      }
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|request|prompt|eventsFile|signalsFile|logFile|outbox/i);
  });

  it.each([
    ["needs_input", { result: "mimo_result", events: "mimo_events", resume: "mimo_resume" }],
    ["blocked", { result: "mimo_result", events: "mimo_events", resume: "mimo_resume" }],
    ["stalled", { result: "mimo_result", events: "mimo_events", resume: "mimo_resume" }],
    ["timeout", { result: "mimo_result", events: "mimo_events", resume: "mimo_resume" }],
    ["completed", { result: "mimo_result", events: "mimo_events" }],
    ["failed", { result: "mimo_result", events: "mimo_events" }],
    ["cancelled", { result: "mimo_result", events: "mimo_events" }]
  ] as const)("renders only valid %s status actions", (status, actions) => {
    expect(renderJobStatus(job({ status, phase: undefined })).actions).toEqual(actions);
  });

  it("renders allowlisted failed jobs with resume action", () => {
    expect(renderJobStatus(job({
      status: "failed",
      phase: undefined,
      errorCode: "build_failed"
    })).actions).toEqual({
      result: "mimo_result",
      events: "mimo_events",
      resume: "mimo_resume"
    });
  });

  it.each(["needs_input", "blocked"] as const)("renders %s as a partial result with resume", (status) => {
    const result = renderJobResult(job({
      status,
      phase: undefined,
      executionCallback: {
        invocationId: "inv-1",
        outcome: "completed",
        sessionId: "ses_123",
        receivedAt: "2026-07-16T00:00:03.000Z"
      },
      verification: [{ command: "npm test", exitCode: 1, passed: false, durationMs: 42 }],
      reportPaths: { json: "report.json", markdown: "report.md", diff: "report.diff" },
      error: status === "needs_input"
        ? "MiMoCode needs additional input."
        : "MiMoCode is blocked by an external condition.",
      errorCode: "needs_input"
    }), { notification: { targetType: "codex", status: "delivered", attempts: 1 } });

    expect(result).toMatchObject({
      resultType: "partial",
      executionCallback: { invocationId: "inv-1", outcome: "completed" },
      verification: [{ command: "npm test", exitCode: 1, passed: false, durationMs: 42 }],
      reportPaths: { json: "report.json", markdown: "report.md", diff: "report.diff" },
      error: status === "needs_input"
        ? "MiMoCode needs additional input."
        : "MiMoCode is blocked by an external condition.",
      errorCode: "needs_input",
      notification: { targetType: "codex", status: "delivered", attempts: 1 },
      actions: { status: "mimo_status", events: "mimo_events", resume: "mimo_resume" }
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|request|prompt|stdout|stderr|raw/i);
  });

  it.each(["completed", "failed", "cancelled"] as const)
    ("renders %s as a final result without resume", (status) => {
      const result = renderJobResult(job({ status, phase: undefined }));
      expect(result.resultType).toBe("final");
      expect(result.actions).toEqual({ status: "mimo_status", events: "mimo_events" });
    });

  it("renders timeout as a partial result with resume", () => {
    const result = renderJobResult(job({ status: "timeout", phase: undefined }));
    expect(result.resultType).toBe("partial");
    expect(result.actions).toEqual({
      status: "mimo_status",
      events: "mimo_events",
      resume: "mimo_resume"
    });
  });

  it("surfaces stale_queued operator summary on status and result paths", () => {
    const failed = job({
      status: "failed",
      phase: undefined,
      errorCode: "stale_queued",
      error: "Job stuck in queued state for longer than 300s.",
      summary: "Job stuck in queued state for longer than 300s."
    });

    expect(renderJobStatus(failed).summary).toBe("MiMoCode job stayed queued too long.");
    expect(renderJobResult(failed)).toMatchObject({
      summary: "MiMoCode job stayed queued too long.",
      error: "MiMoCode job stayed queued too long.",
      errorCode: "stale_queued"
    });
  });

  it("exposes allowlisted notification errorCode with a generic lastError", () => {
    const rendered = renderJobStatus(job({ status: "completed", phase: undefined }), {
      notification: {
        targetType: "codex",
        status: "failed",
        attempts: 1,
        lastError: "Codex App Server executable is unavailable",
        errorCode: "codex_cli_not_executable"
      }
    });

    expect(rendered.notification).toEqual({
      targetType: "codex",
      status: "failed",
      attempts: 1,
      lastError: "Notification delivery requires attention.",
      errorCode: "codex_cli_not_executable"
    });
  });

  it("drops non-allowlisted notification errorCode from public rendering", () => {
    const rendered = renderJobResult(job({ status: "completed", phase: undefined }), {
      notification: {
        targetType: "codex",
        status: "failed",
        attempts: 1,
        lastError: "secret detail",
        errorCode: "private_arbitrary_value" as never
      }
    });

    expect(rendered.notification).toEqual({
      targetType: "codex",
      status: "failed",
      attempts: 1,
      lastError: "Notification delivery requires attention."
    });
    expect(JSON.stringify(rendered.notification)).not.toContain("private_arbitrary_value");
  });

  it("keeps generic failed summaries for unknown errorCode values", () => {
    const failed = job({
      status: "failed",
      phase: undefined,
      errorCode: "agent_said_something_secret",
      error: "SECRET leaked path",
      summary: "SECRET leaked path"
    });

    expect(renderJobStatus(failed).summary).toBe("MiMoCode job failed.");
    expect(renderJobResult(failed).summary).toBe("MiMoCode job failed.");
    expect(renderJobResult(failed).error).toBe("MiMoCode job failed.");
    expect(JSON.stringify(renderJobResult(failed))).not.toContain("SECRET");
  });

  it("omits output from the standard renderer", () => {
    const output = "# Plan\n\nBody";
    const completed = job({ status: "completed", phase: undefined });
    expect(renderJobResult(completed, { output })).not.toHaveProperty("output");
    expect(renderJobResult(completed)).not.toHaveProperty("output");
    expect(renderJobResult(completed, { output: "" })).not.toHaveProperty("output");
    expect(renderJobResult(completed, { output: "   " })).not.toHaveProperty("output");
  });
});
