import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJobStore,
  listJobs,
  readJob,
  resolveJobPaths,
  resolveJobStateFile,
  updateJob
} from "../../src/core/job-store.js";
import { writeJobArtifacts } from "../../src/core/job-artifacts.js";
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

  it("round-trips progress fields and checkpoint report path", () => {
    const cwd = tempWorkspace();
    const timestamp = "2026-07-26T10:00:00.000Z";
    const job = createJobStore(cwd).create({
      kind: "plan",
      task: "Progress fields",
      request: { cwd, task: "Progress fields", progressTimeoutMs: 0, progressWarningMs: 60_000 }
    });
    const checkpoint = path.join(cwd, ".codex-mimo", "checkpoints", `${job.id}.json`);
    const reportPaths = {
      json: path.join(cwd, ".codex-mimo", "reports", `${job.id}.json`),
      checkpoint
    };

    expect(job.progressWarningMs).toBe(60_000);
    expect(job.progressTimeoutMs).toBe(0);

    updateJob(cwd, job.id, {
      lastProgressAt: timestamp,
      progressTimeoutMs: 0,
      reportPaths
    });

    expect(readJob(cwd, job.id)).toMatchObject({
      lastProgressAt: timestamp,
      progressTimeoutMs: 0,
      reportPaths: { checkpoint }
    });
  });

  it("accepts old records without artifactFiles and persists the field when supplied", () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "implement", task: "artifact", request: {} });

    expect(readJob(cwd, job.id)?.artifactFiles).toBeUndefined();
    updateJob(cwd, job.id, { artifactFiles: ["build/classes/App.class"] });
    expect(readJob(cwd, job.id)?.artifactFiles).toEqual(["build/classes/App.class"]);
  });

  it("seeds idleTimeoutMs from the request when available", () => {
    const cwd = tempWorkspace();

    const defaulted = createJobStore(cwd).create({
      kind: "plan",
      task: "Default idle budget",
      request: { cwd, task: "Default idle budget" }
    });
    const disabled = createJobStore(cwd).create({
      kind: "plan",
      task: "Disable idle budget",
      request: { cwd, task: "Disable idle budget", idleTimeoutMs: 0 }
    });
    const custom = createJobStore(cwd).create({
      kind: "plan",
      task: "Custom idle budget",
      request: { cwd, task: "Custom idle budget", idleTimeoutMs: 60_000 }
    });

    expect(defaulted.idleTimeoutMs).toBe(1_800_000);
    expect(disabled.idleTimeoutMs).toBe(0);
    expect(custom.idleTimeoutMs).toBe(60_000);
    expect(readJob(cwd, defaulted.id)?.idleTimeoutMs).toBe(1_800_000);
  });

  it("reads persisted live observation fields", () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "implement",
      task: "Observe stalls",
      request: { cwd, task: "Observe stalls", allowWrite: true, idleTimeoutMs: 1_800_000 }
    });
    fs.writeFileSync(resolveJobPaths(cwd, job.id).jobFile, JSON.stringify({
      ...job,
      lastEventAt: "2026-07-21T10:00:00.000Z",
      lastTool: "bash",
      idleTimeoutMs: 1_800_000
    }), "utf8");

    expect(readJob(cwd, job.id)).toMatchObject({
      lastEventAt: "2026-07-21T10:00:00.000Z",
      lastTool: "bash",
      idleTimeoutMs: 1_800_000
    });
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

  it("round-trips valid execution workspace and frozen review input metadata", () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "review", task: "Review", request: { cwd } });
    const executionPath = path.join(cwd, ".codex-mimo", "execution", "workspace");
    const journalPath = path.join(cwd, ".codex-mimo", "journals", "promotion.json");

    updateJob(cwd, job.id, {
      executionWorkspace: {
        path: executionPath,
        kind: "git_worktree",
        status: "retained",
        isolationGuarantee: "cwd_relative_write_containment",
        journalPath,
        conflictPaths: ["src/index.ts", "packages/core/file.ts"],
        reason: "Control workspace changed during execution."
      },
      reviewInput: {
        status: "verified",
        attachments: [{
          path: path.join(cwd, ".codex-mimo", "inputs", "review.diff"),
          sha256: "a".repeat(64),
          base: "HEAD",
          head: "0123456789abcdef"
        }]
      }
    });

    expect(readJob(cwd, job.id)).toMatchObject({
      executionWorkspace: {
        path: executionPath,
        status: "retained",
        conflictPaths: ["src/index.ts", "packages/core/file.ts"]
      },
      reviewInput: {
        status: "verified",
        attachments: [expect.objectContaining({ sha256: "a".repeat(64) })]
      }
    });
  });

  it.each([
    ["non-object", []],
    ["empty path", { path: "", kind: "copy", status: "prepared", isolationGuarantee: "cwd_relative_write_containment" }],
    ["relative path", { path: "workspace", kind: "copy", status: "prepared", isolationGuarantee: "cwd_relative_write_containment" }],
    ["unknown kind", { path: "C:/workspace", kind: "other", status: "prepared", isolationGuarantee: "cwd_relative_write_containment" }],
    ["unknown status", { path: "C:/workspace", kind: "copy", status: "deleted", isolationGuarantee: "cwd_relative_write_containment" }],
    ["wrong guarantee", { path: "C:/workspace", kind: "copy", status: "prepared", isolationGuarantee: "sandboxed" }],
    ["relative journal", { path: "C:/workspace", kind: "copy", status: "prepared", isolationGuarantee: "cwd_relative_write_containment", journalPath: "journal.json" }],
    ["parent conflict", { path: "C:/workspace", kind: "copy", status: "retained", isolationGuarantee: "cwd_relative_write_containment", conflictPaths: ["src/../secret.ts"] }],
    ["absolute conflict", { path: "C:/workspace", kind: "copy", status: "retained", isolationGuarantee: "cwd_relative_write_containment", conflictPaths: ["/secret.ts"] }],
    ["drive-relative conflict", { path: "C:/workspace", kind: "copy", status: "retained", isolationGuarantee: "cwd_relative_write_containment", conflictPaths: ["C:secret.ts"] }],
    ["empty conflict", { path: "C:/workspace", kind: "copy", status: "retained", isolationGuarantee: "cwd_relative_write_containment", conflictPaths: [""] }],
    ["non-string reason", { path: "C:/workspace", kind: "copy", status: "prepared", isolationGuarantee: "cwd_relative_write_containment", reason: 7 }]
  ])("rejects malformed persisted execution workspace metadata: %s", (_label, executionWorkspace) => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "implement", task: "Validate workspace", request: { cwd } });
    fs.writeFileSync(resolveJobPaths(cwd, job.id).jobFile, JSON.stringify({
      ...job,
      executionWorkspace
    }), "utf8");

    expect(() => readJob(cwd, job.id)).toThrow(/malformed job/i);
    expect(listJobs(cwd).map((entry) => entry.id)).not.toContain(job.id);
  });

  it.each([
    ["invalid job id", () => ({ jobId: "../other" })],
    ["missing creation timestamp", () => ({ createdAt: undefined })],
    ["non-UUID owner token", () => ({ ownerToken: "not-a-uuid" })],
    ["foreign branch", () => ({ branch: "codex-mimo/worktree/other-job" })],
    ["execution root inside control root", () => ({ executionRoot: "C:/control/nested-worktree" })],
    ["unknown field", () => ({ extra: true })]
  ])("rejects malformed persisted persistent-worktree lease: %s", (_label, patch) => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Worktree", request: { workflow: "worktree" } });
    const lease = {
      mode: "persistent" as const,
      jobId: job.id,
      controlRoot: "C:/control",
      executionRoot: "C:/execution",
      ownerMetadataPath: "C:/execution/.git/codex-mimo-execution-workspace.json",
      ownerToken: "2b4a1a94-6d90-4c2d-baa5-6aed2da4c5a8",
      branch: `codex-mimo/worktree/${job.id}`,
      createdAt: "2026-08-02T00:00:00.000Z"
    };
    fs.writeFileSync(resolveJobPaths(cwd, job.id).jobFile, JSON.stringify({
      ...job,
      executionWorkspaceLease: { ...lease, ...patch(job.id) }
    }), "utf8");

    expect(() => readJob(cwd, job.id)).toThrow(/malformed job/i);
    expect(listJobs(cwd).map((entry) => entry.id)).not.toContain(job.id);
  });

  it.each([
    ["non-object", []],
    ["attachments not array", { status: "verified", attachments: "review.diff" }],
    ["empty attachment path", { status: "verified", attachments: [{ path: "", sha256: "a".repeat(64) }] }],
    ["invalid hash", { status: "verified", attachments: [{ path: "review.diff", sha256: "short" }] }],
    ["non-string base", { status: "verified", attachments: [{ path: "review.diff", sha256: "a".repeat(64), base: 1 }] }],
    ["non-string head", { status: "verified", attachments: [{ path: "review.diff", sha256: "a".repeat(64), head: 1 }] }],
    ["unknown status", { status: "pending", attachments: [{ path: "review.diff", sha256: "a".repeat(64) }] }]
  ])("rejects malformed persisted review input metadata: %s", (_label, reviewInput) => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "review", task: "Validate review", request: { cwd } });
    fs.writeFileSync(resolveJobPaths(cwd, job.id).jobFile, JSON.stringify({
      ...job,
      reviewInput
    }), "utf8");

    expect(() => readJob(cwd, job.id)).toThrow(/malformed job/i);
    expect(listJobs(cwd).map((entry) => entry.id)).not.toContain(job.id);
  });

  it("keeps legacy records without execution workspace or review input metadata readable", () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "implement", task: "Legacy", request: { cwd } });
    const legacy = { ...job } as Record<string, unknown>;
    delete legacy.executionWorkspace;
    delete legacy.reviewInput;
    fs.writeFileSync(resolveJobPaths(cwd, job.id).jobFile, JSON.stringify(legacy), "utf8");

    expect(readJob(cwd, job.id)).toMatchObject({ id: job.id, status: "queued" });
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
    "stalled",
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
    ["stalled", "stalled", undefined, null, null],
    ["completed", "completed", undefined, null, null],
    ["failed", "failed", undefined, null, null],
    ["cancelled", "cancelled", undefined, null, null],
    ["timeout", "timeout", undefined, null, null],
    ["running before spawn", "running", undefined, null, null],
    ["running in an active phase", "running", "verifying", null, null],
    ["running with provisional process ownership", "running", "starting", 42, null],
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

  it("reads persisted semantic artifact paths", () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "plan",
      task: "plan",
      request: { cwd, task: "plan" }
    });
    const reportPaths = {
      json: path.join(cwd, ".codex-mimo", "reports", `${job.id}.json`),
      markdown: path.join(cwd, ".codex-mimo", "reports", `${job.id}.md`),
      result: path.join(cwd, ".codex-mimo", "reports", `${job.id}.result.md`),
      plan: path.join(cwd, ".codex-mimo", "reports", `${job.id}.plan.md`),
      verification: path.join(cwd, ".codex-mimo", "reports", `${job.id}.verification.json`)
    };

    updateJob(cwd, job.id, { reportPaths });

    expect(readJob(cwd, job.id)?.reportPaths).toEqual(reportPaths);
  });

  it("round-trips chainId and sliceId", () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "implement",
      task: "slice child",
      request: { cwd, task: "slice child", allowWrite: true }
    });

    updateJob(cwd, job.id, { chainId: "chain-root", sliceId: "slice-1" });

    expect(readJob(cwd, job.id)).toMatchObject({
      chainId: "chain-root",
      sliceId: "slice-1"
    });
  });

  it("persists reportPaths.slices and normalizes path separators", () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "implement",
      task: "root chain",
      request: { cwd, task: "root chain", allowWrite: true }
    });
    const slicesPath = path.join(cwd, ".codex-mimo", "reports", `${job.id}.slices.json`);

    updateJob(cwd, job.id, { reportPaths: { slices: slicesPath } });
    expect(readJob(cwd, job.id)?.reportPaths?.slices).toBe(slicesPath);

    const normalized = writeJobArtifacts({
      job: readJob(cwd, job.id)!,
      status: "completed",
      changedFiles: [],
      verification: [],
      finalText: "",
      plan: false,
      existingReportPaths: { slices: slicesPath }
    });
    expect(normalized.slices).toBe(slicesPath.replace(/\\/g, "/"));
  });

  it.each([
    ["running before spawn", { status: "running", pid: null, processIdentity: null }],
    ["running with provisional process ownership", { status: "running", pid: 42, processIdentity: null }],
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

  it("keeps retention bounded when older jobs are paused", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd, { maxJobs: 2 });

    const needsInput = store.create({ kind: "plan", task: "Need input", request: {} });
    updateJob(cwd, needsInput.id, { status: "needs_input" }, { maxJobs: 2 });
    const blocked = store.create({ kind: "plan", task: "Blocked", request: {} });
    updateJob(cwd, blocked.id, { status: "blocked" }, { maxJobs: 2 });
    const newest = store.create({ kind: "plan", task: "Newest", request: {} });
    updateJob(cwd, newest.id, { status: "completed" }, { maxJobs: 2 });

    expect(listJobs(cwd).map((entry) => entry.id)).toEqual([newest.id, blocked.id]);
    expect(readJob(cwd, needsInput.id)).toBeUndefined();
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
