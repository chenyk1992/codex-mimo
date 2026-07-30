import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mimoResult, mimoStatus } from "../../../src/codex/tools.js";
import {
  collectContextOverheadMetrics,
  resolveContextOverheadFile
} from "../../../src/core/context-overhead.js";
import { COMPACT_RESULT_MAX_BYTES } from "../../../src/core/job-render.js";
import { createJobStore, listJobs } from "../../../src/core/job-store.js";
import { transitionJob } from "../../../src/core/job-transition.js";
import { claimDueDelivery, enqueueDelivery } from "../../../src/notify/outbox.js";
import type { CompactJobResult } from "../../../src/core/jobs.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("context overhead metrics", () => {
  it("counts status/result levels and measures the compact payload without sensitive data", async () => {
    const cwd = makeRoot();
    const marker = "PRIVATE_CONTEXT_MARKER";
    const job = createJobStore(cwd).create({
      kind: "implement",
      task: marker,
      request: { cwd, task: marker, allowWrite: true }
    });
    await transitionJob(cwd, job.id, { status: "running", summary: "running" });
    await transitionJob(cwd, job.id, { status: "completed", summary: marker });

    await mimoStatus({ cwd, jobId: job.id });
    await mimoStatus({ cwd, jobId: job.id, level: "standard" });
    const compact = await mimoResult({ cwd, jobId: job.id }) as CompactJobResult;

    expect(compact.contextOverhead).toEqual({
      tracking: "complete",
      statusCalls: 2,
      resultCalls: 1,
      heartbeatCalls: null,
      compactResultBytes: Buffer.byteLength(JSON.stringify(compact), "utf8"),
      callbackAttempts: 0,
      requestedStandardOrFull: true,
      needsInput: false,
      resumeCount: 0,
      relaunchCount: null
    });
    expect(compact.contextOverhead!.compactResultBytes).toBeLessThanOrEqual(
      COMPACT_RESULT_MAX_BYTES
    );

    const standard = await mimoResult({ cwd, jobId: job.id, level: "standard" });
    expect(standard.contextOverhead).toMatchObject({
      resultCalls: 2,
      requestedStandardOrFull: true,
      compactResultBytes: compact.contextOverhead!.compactResultBytes
    });
    const full = await mimoResult({ cwd, jobId: job.id, level: "full" });
    expect(full.contextOverhead).toMatchObject({ resultCalls: 3 });

    const raw = fs.readFileSync(resolveContextOverheadFile(cwd, job.id), "utf8");
    expect(raw).not.toContain(marker);
    expect(raw).not.toContain(cwd);
    expect(raw).not.toContain(job.id);
  });

  it("aggregates callback attempts, needs_input, and resume children across a job family", async () => {
    const cwd = makeRoot();
    const parent = createJobStore(cwd).create({
      kind: "implement",
      task: "parent",
      request: { cwd, task: "parent", allowWrite: true },
      notificationTarget: { type: "codex", threadId: "thread-private" }
    });
    await transitionJob(cwd, parent.id, { status: "running", summary: "running" });
    await transitionJob(cwd, parent.id, {
      status: "needs_input",
      summary: "needs input",
      errorCode: "acceptance_config_missing"
    });
    await enqueueDelivery(parent.notificationOutboxFile, {
      jobId: parent.id,
      signalCursor: 1,
      target: { type: "codex", threadId: "thread-private" },
      createdAt: parent.createdAt
    });
    await claimDueDelivery(parent.notificationOutboxFile, new Date(), 30_000);

    const child = createJobStore(cwd).create({
      kind: "resume",
      task: "incremental answer",
      request: { cwd, jobId: parent.id, task: "incremental answer" },
      parentJobId: parent.id
    });
    await transitionJob(cwd, child.id, { status: "running", summary: "running" });
    await transitionJob(cwd, child.id, { status: "completed", summary: "done" });

    const result = await mimoResult({ cwd, jobId: child.id });

    expect(result.contextOverhead).toMatchObject({
      tracking: "complete",
      callbackAttempts: 1,
      needsInput: true,
      resumeCount: 1,
      relaunchCount: null
    });
  });

  it("marks historical jobs without sidecar data unavailable instead of guessing", async () => {
    const cwd = makeRoot();
    const job = createJobStore(cwd).create({
      kind: "implement",
      task: "historical",
      request: { cwd, task: "historical", allowWrite: true }
    });
    fs.rmSync(resolveContextOverheadFile(cwd, job.id), { force: true });

    const metrics = collectContextOverheadMetrics(job, listJobs(cwd), []);

    expect(metrics).toMatchObject({
      tracking: "unavailable",
      statusCalls: null,
      resultCalls: null,
      heartbeatCalls: null,
      compactResultBytes: null,
      requestedStandardOrFull: null,
      relaunchCount: null
    });

    await transitionJob(cwd, job.id, { status: "running", summary: "running" });
    await transitionJob(cwd, job.id, { status: "completed", summary: "done" });
    const result = await mimoResult({ cwd, jobId: job.id });
    expect(result.contextOverhead).toMatchObject({
      tracking: "partial",
      statusCalls: 0,
      resultCalls: 1
    });
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-context-overhead-"));
  roots.push(root);
  return root;
}
