import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJobStore, updateJob } from "../../../src/core/job-store.js";
import { FULL_ARTIFACT_MAX_BYTES } from "../../../src/core/job-output.js";
import type { StandardJobResult } from "../../../src/core/jobs.js";
import { mimoResult } from "../../../src/codex/tools.js";
import { enqueueDelivery, completeDelivery, claimDueDelivery, failDelivery } from "../../../src/notify/outbox.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-result-"));
  tempDirs.push(cwd);
  return cwd;
}

function requireStandardResult(
  result: Awaited<ReturnType<typeof mimoResult>>
): asserts result is StandardJobResult {
  if (!("jobId" in result)) throw new Error("Expected a standard job result.");
}

afterEach(() => {
  for (const cwd of tempDirs.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

describe("mimo_result", () => {
  it.each(["needs_input", "blocked", "stalled", "completed", "failed", "cancelled", "timeout"] as const)
    ("reads %s jobs", async (status) => {
      const cwd = tempWorkspace();
      const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
      updateJob(cwd, job.id, {
        status,
        summary: `${status} summary`,
        sessionId: status === "needs_input" || status === "blocked" || status === "stalled" ? "ses_1" : null
      });

      const compact = await mimoResult({ cwd, jobId: job.id });
      expect(compact.status).toBe(status);
      expect(compact).not.toHaveProperty("jobId");
      expect(compact).not.toHaveProperty("resultType");

      const standard = await mimoResult({ cwd, jobId: job.id, level: "standard" });
      requireStandardResult(standard);
      expect(standard.resultType).toBe(
        status === "needs_input" || status === "blocked" || status === "stalled" || status === "timeout"
          ? "partial"
          : "final"
      );
    });

  it.each(["queued", "running"] as const)("rejects %s jobs", async (status) => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "plan", task: "Plan", request: {} });
    if (status === "running") {
      updateJob(cwd, job.id, { status, pid: 10, processIdentity: "start-10" });
    }
    await expect(mimoResult({ cwd, jobId: job.id })).rejects.toThrow("Job result is not available");
  });

  it("returns the latest persisted notification delivery state", async () => {
    const cwd = tempWorkspace();
    const target = { type: "codex" as const, threadId: "thread-1" };
    const job = createJobStore(cwd).create({
      kind: "review", task: "Review", request: {}, notificationTarget: target
    });
    updateJob(cwd, job.id, { status: "completed", summary: "Done." });
    await enqueueDelivery(job.notificationOutboxFile, {
      jobId: job.id, signalCursor: 1, target, createdAt: "2026-07-16T00:00:00.000Z"
    });
    const claimed = await claimDueDelivery(job.notificationOutboxFile, new Date("2026-07-16T00:00:01.000Z"), 30_000);
    await completeDelivery(job.notificationOutboxFile, claimed!.id, claimed!.attempts, new Date("2026-07-16T00:00:02.000Z"));

    const result = await mimoResult({ cwd, jobId: job.id, level: "standard" });
    requireStandardResult(result);
    expect(result.notification).toEqual({
      targetType: "codex", status: "delivered", attempts: 1
    });
  });


  it("forwards allowlisted notification errorCode on failed delivery", async () => {
    const cwd = tempWorkspace();
    const target = { type: "codex" as const, threadId: "thread-1" };
    const job = createJobStore(cwd).create({
      kind: "review", task: "Review", request: {}, notificationTarget: target
    });
    updateJob(cwd, job.id, { status: "completed", summary: "Done." });
    await enqueueDelivery(job.notificationOutboxFile, {
      jobId: job.id, signalCursor: 1, target, createdAt: "2026-07-16T00:00:00.000Z"
    });
    const claimed = await claimDueDelivery(job.notificationOutboxFile, new Date("2026-07-16T00:00:01.000Z"), 30_000);
    await failDelivery(
      job.notificationOutboxFile,
      claimed!.id,
      claimed!.attempts,
      "cli missing",
      "codex_cli_not_found"
    );

    const result = await mimoResult({ cwd, jobId: job.id, level: "standard" });
    requireStandardResult(result);
    expect(result.notification).toEqual({
      targetType: "codex",
      status: "failed",
      attempts: 1,
      lastError: "Notification delivery requires attention.",
      errorCode: "codex_cli_not_found"
    });
  });

  it("selects the most recent readable result when jobId is omitted", async () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const finished = store.create({ kind: "plan", task: "First", request: {} });
    store.create({ kind: "plan", task: "Still running", request: {} });
    const markdownPath = path.join(cwd, ".codex-mimo", "reports", `${finished.id}.md`);
    updateJob(cwd, finished.id, {
      status: "failed",
      summary: "First failed",
      reportPaths: { markdown: markdownPath }
    });
    const result = await mimoResult({ cwd });
    expect(result.reportPath).toContain(`${finished.id}.md`);
    expect(result).not.toHaveProperty("jobId");
  });

  it("omits final output by default and exposes it only at full level", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "plan", task: "Plan", request: {} });
    const output = "# Plan\n\nComplete carousel implementation.";
    fs.writeFileSync(
      job.eventsFile,
      `${JSON.stringify({ type: "text", part: { text: output } })}\n`,
      "utf8"
    );
    updateJob(cwd, job.id, {
      status: "completed",
      summary: "Done.",
      reportPaths: {
        markdown: path.join(cwd, ".codex-mimo", "reports", `${job.id}.md`),
        plan: path.join(cwd, ".codex-mimo", "reports", `${job.id}.plan.md`)
      }
    });

    const compact = await mimoResult({ cwd, jobId: job.id });
    expect(compact).toMatchObject({
      status: "completed",
      summary: "Complete carousel implementation.",
      reportPath: expect.stringContaining(`${job.id}.plan.md`)
    });
    expect(compact).not.toHaveProperty("output");

    const full = await mimoResult({ cwd, jobId: job.id, level: "full" });
    expect(full).toMatchObject({ output });
  });

  it("returns an exact artifact_too_large reference from full level", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "plan", task: "Plan", request: {} });
    const resultFile = path.join(cwd, "oversized.result.md");
    fs.writeFileSync(resultFile, "x".repeat(FULL_ARTIFACT_MAX_BYTES + 1), "utf8");
    updateJob(cwd, job.id, {
      status: "completed",
      reportPaths: { result: resultFile }
    });

    const full = await mimoResult({ cwd, jobId: job.id, level: "full" });
    expect(full).toMatchObject({
      artifactErrors: [{
        code: "artifact_too_large",
        artifact: "output",
        path: resultFile,
        bytes: FULL_ARTIFACT_MAX_BYTES + 1
      }]
    });
    expect(full).not.toHaveProperty("output");
  });

  it("returns one bounded verification excerpt at standard level", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Test", request: {} });
    const verificationFile = path.join(cwd, "verification.json");
    fs.writeFileSync(verificationFile, JSON.stringify([{
      command: "npm test",
      exitCode: 1,
      passed: false,
      stdout: "",
      stderr: "token=private assertion failed"
    }]), "utf8");
    updateJob(cwd, job.id, {
      status: "failed",
      errorCode: "verification_failed",
      verification: [{ command: "npm test", exitCode: 1, passed: false }],
      reportPaths: { verification: verificationFile }
    });

    const standard = await mimoResult({ cwd, jobId: job.id, level: "standard" });
    expect(standard).toMatchObject({
      keyError: "token=[REDACTED] assertion failed"
    });
    expect(standard).not.toHaveProperty("output");
  });

  it("omits output for a legacy terminal job with a missing events file", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "plan", task: "Plan", request: {} });
    updateJob(cwd, job.id, { status: "completed", summary: "Done." });
    fs.rmSync(job.eventsFile, { force: true });

    const result = await mimoResult({ cwd, jobId: job.id });
    expect(result).toMatchObject({ status: "completed", reportPath: null });
    expect(result).not.toHaveProperty("output");
  });
});
