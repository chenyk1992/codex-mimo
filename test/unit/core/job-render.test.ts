import { describe, expect, it, vi } from "vitest";
import { renderJobStatus } from "../../../src/core/job-render.js";
import type { JobRecord } from "../../../src/core/jobs.js";

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
    processIdentity: "win32:x",
    sessionId: "ses_abc",
    parentJobId: null,
    createdAt: "2026-07-21T07:00:00.000Z",
    startedAt: "2026-07-21T07:00:00.000Z",
    updatedAt: "2026-07-21T07:12:34.000Z",
    changedFiles: [],
    verification: [],
    logFile: "PRIVATE job.log",
    eventsFile: "PRIVATE events.jsonl",
    signalsFile: "PRIVATE signals.jsonl",
    notificationOutboxFile: "PRIVATE notifications.jsonl",
    ...patch
  } as JobRecord;
}

describe("renderJobStatus idle and process observability fields", () => {
  it("exposes idleMs, lastTool, sessionId, processAlive, idleTimeoutMs from brief scenario", () => {
    const record = job({
      status: "running",
      startedAt: "2026-07-21T07:00:00.000Z",
      lastEventAt: "2026-07-21T07:12:34.000Z",
      lastTool: "write",
      idleTimeoutMs: 1_800_000,
      sessionId: "ses_abc",
      pid: 123,
      processIdentity: "win32:x"
    });

    const status = renderJobStatus(record, {
      nowMs: Date.parse("2026-07-21T07:42:34.000Z"),
      processAlive: false
    });

    expect(status.idleMs).toBe(1_800_000);
    expect(status.lastTool).toBe("write");
    expect(status.sessionId).toBe("ses_abc");
    expect(status.processAlive).toBe(false);
    expect(status.idleTimeoutMs).toBe(1_800_000);
    expect(status.lastEventAt).toBe("2026-07-21T07:12:34.000Z");
  });

  it("computes idleMs from nowMs minus lastEventAt while running", () => {
    const record = job({
      status: "running",
      lastEventAt: "2026-07-21T08:00:00.000Z",
      idleTimeoutMs: 1_800_000
    });

    const status = renderJobStatus(record, {
      nowMs: Date.parse("2026-07-21T08:05:00.000Z")
    });

    expect(status.idleMs).toBe(300_000);
    expect(status.idleTimeoutMs).toBe(1_800_000);
  });

  it("returns idleMs null when job is not running", () => {
    const record = job({
      status: "completed",
      phase: undefined,
      pid: null,
      processIdentity: null,
      lastEventAt: "2026-07-21T08:00:00.000Z",
      lastTool: "write",
      idleTimeoutMs: 1_800_000
    });

    const status = renderJobStatus(record, {
      nowMs: Date.parse("2026-07-21T08:05:00.000Z")
    });

    expect(status.idleMs).toBe(null);
  });

  it("returns idleMs null when running but lastEventAt is missing", () => {
    const record = job({
      status: "running",
      lastEventAt: undefined
    });

    const status = renderJobStatus(record, {
      nowMs: Date.parse("2026-07-21T08:05:00.000Z")
    });

    expect(status.idleMs).toBe(null);
  });

  it("clamps idleMs to zero when nowMs is before lastEventAt", () => {
    const record = job({
      status: "running",
      lastEventAt: "2026-07-21T08:05:00.000Z"
    });

    const status = renderJobStatus(record, {
      nowMs: Date.parse("2026-07-21T08:04:59.000Z")
    });

    expect(status.idleMs).toBe(0);
  });

  it("surfaces lastTool null when not recorded", () => {
    const record = job({ lastTool: undefined });
    const status = renderJobStatus(record, { nowMs: Date.parse("2026-07-21T08:05:00.000Z") });
    expect(status.lastTool).toBe(null);
  });

  it("surfaces lastEventAt null when not recorded", () => {
    const record = job({ lastEventAt: undefined });
    const status = renderJobStatus(record, { nowMs: Date.parse("2026-07-21T08:05:00.000Z") });
    expect(status.lastEventAt).toBe(null);
  });

  it("surfaces idleTimeoutMs null when not recorded", () => {
    const record = job({ idleTimeoutMs: undefined });
    const status = renderJobStatus(record, { nowMs: Date.parse("2026-07-21T08:05:00.000Z") });
    expect(status.idleTimeoutMs).toBe(null);
  });

  it("reports processAlive unknown when running with pid but no probe supplied", () => {
    const record = job({ status: "running", pid: 123, processIdentity: "win32:x" });
    const status = renderJobStatus(record, { nowMs: Date.parse("2026-07-21T08:05:00.000Z") });
    expect(status.processAlive).toBe("unknown");
  });

  it("omits processAlive when not running", () => {
    const record = job({
      status: "completed",
      phase: undefined,
      pid: null,
      processIdentity: null
    });
    const status = renderJobStatus(record, { nowMs: Date.parse("2026-07-21T08:05:00.000Z") });
    expect(status).not.toHaveProperty("processAlive");
  });

  it("omits processAlive when running without a pid", () => {
    const record = job({ status: "running", pid: null, processIdentity: null });
    const status = renderJobStatus(record, { nowMs: Date.parse("2026-07-21T08:05:00.000Z") });
    expect(status).not.toHaveProperty("processAlive");
  });

  it("forwards explicit processAlive true", () => {
    const record = job({ status: "running", pid: 123, processIdentity: "win32:x" });
    const status = renderJobStatus(record, {
      nowMs: Date.parse("2026-07-21T08:05:00.000Z"),
      processAlive: true
    });
    expect(status.processAlive).toBe(true);
  });

  it("forwards explicit processAlive unknown", () => {
    const record = job({ status: "running", pid: 123, processIdentity: "win32:x" });
    const status = renderJobStatus(record, {
      nowMs: Date.parse("2026-07-21T08:05:00.000Z"),
      processAlive: "unknown"
    });
    expect(status.processAlive).toBe("unknown");
  });

  it("does not leak private observation fields beyond what is whitelisted", () => {
    const record = job({
      status: "running",
      lastEventAt: "2026-07-21T07:12:34.000Z",
      lastTool: "write",
      idleTimeoutMs: 1_800_000
    });
    const status = renderJobStatus(record, {
      nowMs: Date.parse("2026-07-21T07:42:34.000Z"),
      processAlive: false
    });
    expect(JSON.stringify(status)).not.toMatch(/PRIVATE|request|prompt|logFile|eventsFile|signalsFile|outbox/i);
  });
});
