import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJobStore,
  failStaleJobs,
  listJobs,
  readJob,
  resolveJobPaths,
  resolveJobStateFile,
  updateJob
} from "../../src/core/job-store.js";
import { withProcessLock } from "../../src/core/process-lock.js";

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-job-store-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const cwd of tempDirs.splice(0)) {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

describe("job store", () => {
  it("rejects unsafe job ids before resolving paths", () => {
    const cwd = tempWorkspace();

    expect(() => resolveJobPaths(cwd, "../outside")).toThrow(/invalid job id/i);
    expect(() => resolveJobPaths(cwd, "")).toThrow(/invalid job id/i);
    expect(() => resolveJobPaths(cwd, "state")).toThrow(/invalid job id/i);
    expect(() => resolveJobPaths(cwd, "a\\b")).toThrow(/invalid job id/i);
    expect(() => readJob(cwd, "a/b")).toThrow(/invalid job id/i);
  });

  it("creates a job with per-job paths and newest-first state", () => {
    const cwd = tempWorkspace();
    const task = "Run dev workflow";
    const request = { workflow: "dev", task };
    const notificationTarget = { type: "codex" as const, threadId: "thread-1" };

    const job = createJobStore(cwd).create({ kind: "compose", task, request, notificationTarget });
    const paths = resolveJobPaths(cwd, job.id);

    expect(job.id.startsWith("compose-")).toBe(true);
    expect(job.status).toBe("queued");
    expect(job).not.toHaveProperty("phase");
    expect(job).not.toHaveProperty("workflow");
    expect(job.notificationTarget).toEqual(notificationTarget);
    expect(fs.existsSync(paths.jobFile)).toBe(true);
    expect(job.eventsFile.endsWith(".events.jsonl")).toBe(true);
    expect(job.signalsFile.endsWith(".signals.jsonl")).toBe(true);
    expect(job.signalsFile).toBe(paths.signalsFile);
    expect(job.notificationOutboxFile).toBe(path.join(cwd, ".codex-mimo", "jobs", "notifications.jsonl"));
    expect(job.notificationOutboxFile).toBe(paths.notificationOutboxFile);
    expect(readJob(cwd, job.id)?.task).toBe(task);
    expect(listJobs(cwd).map((entry) => entry.id)).toEqual([job.id]);
  });

  it("updates a job without losing immutable fields", () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      task: "Run dev workflow",
      request: { workflow: "dev" }
    });

    const updated = updateJob(cwd, job.id, {
      status: "running", phase: "starting", pid: 123, processIdentity: "start-123"
    });

    expect(updated.id).toBe(job.id);
    expect(updated.kind).toBe(job.kind);
    expect(updated.cwd).toBe(job.cwd);
    expect(updated.createdAt).toBe(job.createdAt);
    expect(updated.status).toBe("running");
    expect(updated.phase).toBe("starting");
    expect(updated.pid).toBe(123);
    expect(updated.updatedAt >= job.updatedAt).toBe(true);
  });

  it("recovers state from job files when state json is corrupt", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);

    const first = store.create({ kind: "compose", task: "First", request: { workflow: "dev" } });
    fs.writeFileSync(resolveJobPaths(cwd, "compose-bad-file").jobFile, "{bad-job", "utf-8");
    fs.writeFileSync(resolveJobPaths(cwd, "compose-empty").jobFile, "{}", "utf-8");
    fs.writeFileSync(
      resolveJobPaths(cwd, "compose-mismatch").jobFile,
      JSON.stringify({ ...first, id: "compose-different" }),
      "utf-8"
    );
    fs.writeFileSync(resolveJobStateFile(cwd), "{not-json", "utf-8");

    const second = store.create({ kind: "compose", task: "Second", request: { workflow: "dev" } });

    expect(listJobs(cwd).map((entry) => entry.id)).toEqual([second.id, first.id]);
  });

  it.each(["EPERM", "EACCES", "EBUSY"])(
    "retries a transient Windows %s while replacing an authoritative job record",
    (code) => {
      const cwd = tempWorkspace();
      const job = createJobStore(cwd).create({ kind: "implement", task: "retry", request: { cwd } });
      const jobFile = resolveJobPaths(cwd, job.id).jobFile;
      const rename = fs.renameSync.bind(fs);
      let attempts = 0;
      vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
        if (target === jobFile && attempts++ === 0) {
          throw Object.assign(new Error(`transient ${code}`), { code });
        }
        return rename(source, target);
      });

      const updated = updateJob(cwd, job.id, {
        status: "running", phase: "starting", pid: 101, processIdentity: "retry-101"
      });

      expect(updated.status).toBe("running");
      expect(readJob(cwd, job.id)?.status).toBe("running");
      expect(attempts).toBe(2);
    }
  );

  it("retries independently across consecutive authoritative writes", () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "implement", task: "retry twice", request: { cwd } });
    const jobFile = resolveJobPaths(cwd, job.id).jobFile;
    const rename = fs.renameSync.bind(fs);
    let attempts = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (target === jobFile && attempts++ % 2 === 0) {
        throw Object.assign(new Error("transient EBUSY"), { code: "EBUSY" });
      }
      return rename(source, target);
    });

    updateJob(cwd, job.id, {
      status: "running", phase: "starting", pid: 102, processIdentity: "retry-102"
    });
    const completed = updateJob(cwd, job.id, {
      status: "completed", phase: undefined, pid: null, processIdentity: null, summary: "done"
    });

    expect(completed.status).toBe("completed");
    expect(readJob(cwd, job.id)?.summary).toBe("done");
    expect(attempts).toBe(4);
  });

  it("throws the original transient error after the bounded retry budget is exhausted", () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "implement", task: "exhaust", request: { cwd } });
    const jobFile = resolveJobPaths(cwd, job.id).jobFile;
    const transient = Object.assign(new Error("still busy"), { code: "EBUSY" });
    let attempts = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((_source, target) => {
      if (target === jobFile) attempts += 1;
      throw transient;
    });

    expect(() => updateJob(cwd, job.id, { summary: "not persisted" })).toThrow(transient);
    expect(attempts).toBe(5);
    expect(readJob(cwd, job.id)?.summary).toBeUndefined();
  });

  it("does not retry a non-transient rename failure", () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "implement", task: "fail", request: { cwd } });
    const jobFile = resolveJobPaths(cwd, job.id).jobFile;
    const failure = Object.assign(new Error("missing temp"), { code: "ENOENT" });
    let attempts = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((_source, target) => {
      if (target === jobFile) attempts += 1;
      throw failure;
    });

    expect(() => updateJob(cwd, job.id, { summary: "not persisted" })).toThrow(failure);
    expect(attempts).toBe(1);
  });

  it("does not retry Windows error codes on another platform", () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "implement", task: "platform", request: { cwd } });
    const jobFile = resolveJobPaths(cwd, job.id).jobFile;
    const failure = Object.assign(new Error("permission"), { code: "EPERM" });
    let attempts = 0;
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.spyOn(fs, "renameSync").mockImplementation((_source, target) => {
      if (target === jobFile) attempts += 1;
      throw failure;
    });
    try {
      expect(() => updateJob(cwd, job.id, { summary: "not persisted" })).toThrow(failure);
      expect(attempts).toBe(1);
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
  });

  it("creates and lists an authoritative job when the state cache cannot be written", async () => {
    const cwd = tempWorkspace();
    fs.mkdirSync(resolveJobStateFile(cwd), { recursive: true });

    const job = createJobStore(cwd).create({
      kind: "implement",
      task: "cache independent",
      request: { cwd }
    });

    expect(readJob(cwd, job.id)).toEqual(job);
    expect(listJobs(cwd).map((entry) => entry.id)).toContain(job.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("does not leave a cache refresh waiting after an authoritative synchronous write", async () => {
    const cwd = tempWorkspace();
    const stateFile = resolveJobStateFile(cwd);

    await withProcessLock(stateFile, async () => {
      createJobStore(cwd).create({
        kind: "implement",
        task: "no lingering refresh",
        request: { cwd }
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      fs.rmSync(cwd, { recursive: true, force: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fs.existsSync(cwd)).toBe(false);
  });

  it("throws when reading an existing malformed job file directly", () => {
    const cwd = tempWorkspace();
    const paths = resolveJobPaths(cwd, "compose-bad-file");
    fs.mkdirSync(path.dirname(paths.jobFile), { recursive: true });
    fs.writeFileSync(paths.jobFile, "{bad-job", "utf-8");

    expect(() => readJob(cwd, "compose-bad-file")).toThrow(/malformed job/i);

    fs.writeFileSync(paths.jobFile, "{}", "utf-8");

    expect(() => readJob(cwd, "compose-bad-file")).toThrow(/malformed job/i);
  });

  it("rejects persisted callback metadata containing transient final text", () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      task: "Run dev workflow",
      request: { workflow: "dev" }
    });
    const paths = resolveJobPaths(cwd, job.id);
    fs.writeFileSync(paths.jobFile, JSON.stringify({
      ...job,
      executionCallback: {
        invocationId: "inv-1",
        outcome: "completed",
        finalText: "must remain transient"
      }
    }), "utf-8");

    expect(() => readJob(cwd, job.id)).toThrow(/malformed job/i);
  });

  it.each([
    ["removed ACP kind", { kind: "acp" }],
    ["removed terminal phase", { phase: "done" }],
    ["unknown status", { status: "pending" }]
  ])("rejects persisted records with an invalid exact union: %s", (_label, patch) => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "implement",
      task: "validate exact unions",
      request: { cwd }
    });
    fs.writeFileSync(resolveJobPaths(cwd, job.id).jobFile, JSON.stringify({
      ...job,
      ...patch
    }), "utf8");

    expect(() => readJob(cwd, job.id)).toThrow(/malformed job/i);
  });

  it.each([
    "queued",
    "needs_input",
    "blocked",
    "completed",
    "failed",
    "cancelled",
    "timeout"
  ])("rejects a persisted %s record with an active phase", (status) => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "implement",
      task: "validate normalized record state",
      request: { cwd }
    });
    fs.writeFileSync(resolveJobPaths(cwd, job.id).jobFile, JSON.stringify({
      ...job,
      status,
      phase: "starting",
      pid: null,
      processIdentity: null
    }), "utf8");

    expect(() => readJob(cwd, job.id)).toThrow(/malformed job/i);
  });

  it.each([
    ["queued", "queued", undefined, null, null],
    ["needs_input", "needs_input", undefined, null, null],
    ["blocked", "blocked", undefined, null, null],
    ["completed", "completed", undefined, null, null],
    ["failed", "failed", undefined, null, null],
    ["cancelled", "cancelled", undefined, null, null],
    ["timeout", "timeout", undefined, null, null],
    ["running before spawn", "running", undefined, null, null],
    ["running in an active phase", "running", "verifying", null, null],
    ["running with an owned process", "running", "editing", 42, "start-42"]
  ])("reads normalized persisted state: %s", (_label, status, phase, pid, processIdentity) => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "implement",
      task: "validate normalized record state",
      request: { cwd }
    });
    const record = { ...job, status, pid, processIdentity } as Record<string, unknown>;
    if (phase !== undefined) record.phase = phase;
    fs.writeFileSync(resolveJobPaths(cwd, job.id).jobFile, JSON.stringify(record), "utf8");

    expect(readJob(cwd, job.id)).toMatchObject({ status, pid, processIdentity });
    expect(readJob(cwd, job.id)?.phase).toBe(phase);
  });

  it.each([
    ["queued with a process", { status: "queued", pid: 42, processIdentity: "start-42" }],
    ["completed with an identity", { status: "completed", pid: null, processIdentity: "start-42" }],
    ["running with only a pid", { status: "running", pid: 42, processIdentity: null }],
    ["running with only an identity", { status: "running", pid: null, processIdentity: "start-42" }],
    ["running with an empty identity", { status: "running", pid: 42, processIdentity: "" }],
    ["running with a zero pid", { status: "running", pid: 0, processIdentity: "start-42" }],
    ["running with a negative pid", { status: "running", pid: -1, processIdentity: "start-42" }],
    ["running with a fractional pid", { status: "running", pid: 1.5, processIdentity: "start-42" }],
    ["running with a string pid", { status: "running", pid: "42", processIdentity: "start-42" }]
  ])("rejects persisted process state: %s", (_label, patch) => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "implement",
      task: "validate process state",
      request: { cwd }
    });
    fs.writeFileSync(resolveJobPaths(cwd, job.id).jobFile, JSON.stringify({
      ...job,
      ...patch
    }), "utf8");

    expect(() => readJob(cwd, job.id)).toThrow(/malformed job/i);
  });

  it.each([
    ["running before spawn", { status: "running", pid: null, processIdentity: null }],
    ["running with owned process", { status: "running", pid: 42, processIdentity: "start-42" }],
    ["completed", { status: "completed", pid: null, processIdentity: null }]
  ])("reads valid persisted process state: %s", (_label, patch) => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "implement",
      task: "validate process state",
      request: { cwd }
    });
    fs.writeFileSync(resolveJobPaths(cwd, job.id).jobFile, JSON.stringify({
      ...job,
      ...patch
    }), "utf8");

    expect(readJob(cwd, job.id)).toMatchObject(patch);
  });

  it("does not prune active jobs", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd, { maxJobs: 2 });

    const active = store.create({ kind: "compose", task: "Active", request: { workflow: "dev" } });
    const completed = store.create({ kind: "compose", task: "Completed", request: { workflow: "dev" } });
    updateJob(cwd, completed.id, { status: "completed", phase: undefined }, { maxJobs: 2 });
    const newest = store.create({ kind: "compose", task: "Newest", request: { workflow: "dev" } });
    updateJob(cwd, newest.id, { status: "completed", phase: undefined }, { maxJobs: 2 });

    expect(readJob(cwd, active.id)?.status).toBe("queued");
    expect(listJobs(cwd).map((entry) => entry.id)).toEqual([newest.id, active.id]);
  });

  it("uses update maxJobs option when pruning after updates", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd, { maxJobs: 3 });

    const first = store.create({ kind: "compose", task: "First", request: { workflow: "dev" } });
    const second = store.create({ kind: "compose", task: "Second", request: { workflow: "dev" } });
    const third = store.create({ kind: "compose", task: "Third", request: { workflow: "dev" } });

    updateJob(cwd, second.id, { status: "completed", phase: undefined }, { maxJobs: 3 });
    updateJob(cwd, third.id, { status: "completed", phase: undefined }, { maxJobs: 3 });
    updateJob(cwd, first.id, { status: "completed", phase: undefined }, { maxJobs: 2 });

    expect(listJobs(cwd).map((entry) => entry.id)).toEqual([first.id, third.id]);
    expect(readJob(cwd, second.id)).toBeUndefined();
  });

  it("does not delete malformed job artifacts while pruning state", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);

    const job = store.create({ kind: "compose", task: "Valid", request: { workflow: "dev" } });
    const partialPaths = resolveJobPaths(cwd, "compose-partial");
    fs.writeFileSync(partialPaths.jobFile, "{partial-job", "utf-8");
    fs.writeFileSync(partialPaths.logFile, "partial log", "utf-8");
    fs.writeFileSync(partialPaths.eventsFile, "{}\n", "utf-8");
    fs.writeFileSync(resolveJobStateFile(cwd), JSON.stringify({ jobs: ["compose-partial", job.id] }), "utf-8");

    updateJob(cwd, job.id, { status: "completed", phase: undefined }, { maxJobs: 10 });

    expect(fs.existsSync(partialPaths.jobFile)).toBe(true);
    expect(fs.existsSync(partialPaths.logFile)).toBe(true);
    expect(fs.existsSync(partialPaths.eventsFile)).toBe(true);
    expect(listJobs(cwd).map((entry) => entry.id)).toEqual([job.id]);
  });

  it("prunes state entries while keeping newest jobs", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd, { maxJobs: 2 });

    const first = store.create({ kind: "compose", task: "First", request: { workflow: "dev" } });
    const second = store.create({ kind: "compose", task: "Second", request: { workflow: "dev" } });
    const firstPaths = resolveJobPaths(cwd, first.id);
    fs.writeFileSync(firstPaths.logFile, "first log", "utf-8");
    fs.writeFileSync(firstPaths.eventsFile, "{}\n", "utf-8");
    fs.writeFileSync(firstPaths.signalsFile, "{}\n", "utf-8");
    updateJob(cwd, first.id, { status: "completed", phase: undefined }, { maxJobs: 2 });
    updateJob(cwd, second.id, { status: "completed", phase: undefined }, { maxJobs: 2 });
    const third = store.create({ kind: "compose", task: "Third", request: { workflow: "dev" } });

    expect(listJobs(cwd).map((entry) => entry.id)).toEqual([third.id, second.id]);
    expect(fs.existsSync(firstPaths.jobFile)).toBe(false);
    expect(fs.existsSync(firstPaths.logFile)).toBe(false);
    expect(fs.existsSync(firstPaths.eventsFile)).toBe(false);
    expect(fs.existsSync(firstPaths.signalsFile)).toBe(false);
  });
});

describe("failStaleJobs", () => {
  it("marks queued jobs older than threshold as failed", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", task: "Stuck task", request: { workflow: "dev" } });

    const failed = failStaleJobs(cwd, { staleThresholdMs: -1 });
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe(job.id);

    const updated = readJob(cwd, job.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.errorCode).toBe("stale_queued");
  });

  it("does not affect running or completed jobs", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const running = store.create({ kind: "compose", task: "Running", request: { workflow: "dev" } });
    updateJob(cwd, running.id, { status: "running", phase: "starting" });
    const completed = store.create({ kind: "compose", task: "Done", request: { workflow: "dev" } });
    updateJob(cwd, completed.id, { status: "completed", phase: undefined });

    const failed = failStaleJobs(cwd, { staleThresholdMs: 0 });
    expect(failed).toHaveLength(0);
  });

  it("does not affect recent queued jobs", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    store.create({ kind: "compose", task: "Fresh", request: { workflow: "dev" } });

    const failed = failStaleJobs(cwd, { staleThresholdMs: 300_000 });
    expect(failed).toHaveLength(0);
  });
});
