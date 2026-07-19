import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mimoResume } from "../../../src/codex/tools.js";
import { createJobStore, listJobs, readJob, updateJob } from "../../../src/core/job-store.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-resume-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const cwd of tempDirs.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

function parent(cwd: string, status: "needs_input" | "blocked" = "blocked") {
  const record = createJobStore(cwd).create({
    kind: "implement",
    task: "Build feature",
    request: { cwd, task: "Build feature", allowWrite: true },
    notificationTarget: { type: "codex", threadId: "thread-parent" }
  });
  return updateJob(cwd, record.id, { status, sessionId: "ses_parent", summary: "Need help." });
}

describe("mimo_resume", () => {
  it.each(["needs_input", "blocked"] as const)
    ("creates a queued resume child for a %s parent and inherits its frozen target", async (status) => {
      const cwd = tempWorkspace();
      const source = parent(cwd, status);
      const spawnJobSupervisor = vi.fn().mockReturnValue(123);

      const receipt = await mimoResume({ cwd, jobId: source.id, task: "Continue" }, {
        env: { CODEX_THREAD_ID: "thread-drifted" }, spawnJobSupervisor
      });

      expect(receipt).toEqual({
        jobId: expect.any(String), kind: "resume", status: "queued",
        actions: {
          status: "mimo_status", events: "mimo_events", result: "mimo_result", cancel: "mimo_cancel"
        }
      });
      const child = readJob(cwd, receipt.jobId)!;
      expect(child).toMatchObject({
        kind: "resume",
        parentJobId: source.id,
        notificationTarget: { type: "codex", threadId: "thread-parent" },
        request: { cwd, jobId: source.id, task: "Continue", sessionId: "ses_parent" }
      });
      expect(spawnJobSupervisor).toHaveBeenCalledWith(cwd);
    });

  it("uses an explicit notification override instead of the parent target", async () => {
    const cwd = tempWorkspace();
    const source = parent(cwd);
    const receipt = await mimoResume({
      cwd,
      jobId: source.id,
      task: "Continue",
      notify: { type: "webhook", url: "https://example.test/hook", secretEnv: "HOOK_SECRET" }
    }, { env: {}, spawnJobSupervisor: vi.fn().mockReturnValue(123) });

    expect(readJob(cwd, receipt.jobId)?.notificationTarget).toEqual({
      type: "webhook", url: "https://example.test/hook", secretEnv: "HOOK_SECRET"
    });
  });

  it("inherits the absence of a target without re-resolving ambient CODEX_THREAD_ID", async () => {
    const cwd = tempWorkspace();
    const source = createJobStore(cwd).create({
      kind: "plan",
      task: "Plan",
      request: { cwd, task: "Plan" }
    });
    updateJob(cwd, source.id, { status: "needs_input", sessionId: "ses_parent" });
    const receipt = await mimoResume({ cwd, jobId: source.id, task: "Continue" }, {
      env: { CODEX_THREAD_ID: "must-not-drift" }, spawnJobSupervisor: vi.fn().mockReturnValue(123)
    });
    expect(readJob(cwd, receipt.jobId)?.notificationTarget).toBeUndefined();
  });

  it.each([
    ["completed", "ses_parent", "must be needs_input or blocked"],
    ["blocked", null, "does not have a sessionId"]
  ] as const)("rejects invalid parent status/session without persisting a child", async (status, sessionId, message) => {
    const cwd = tempWorkspace();
    const source = createJobStore(cwd).create({ kind: "plan", task: "Plan", request: {} });
    updateJob(cwd, source.id, { status, sessionId });

    await expect(mimoResume({ cwd, jobId: source.id, task: "Continue" }, {
      env: {}, spawnJobSupervisor: vi.fn().mockReturnValue(123)
    })).rejects.toThrow(message);
    expect(listJobs(cwd).map((job) => job.id)).toEqual([source.id]);
  });

  it.each([
    ["plan", { task: "Plan", cwd: "" }, { agent: "plan", writesAllowed: false }],
    ["review", { base: "HEAD", cwd: "" }, { agent: "plan", writesAllowed: false }],
    ["compose", { workflow: "plan", task: "Plan", cwd: "" }, { agent: "compose", writesAllowed: false }],
    ["compose", { workflow: "dev", task: "Build", cwd: "" }, { agent: "compose", writesAllowed: true }]
  ] as const)("freezes the effective %s parent policy into the child request", async (kind, template, expected) => {
    const cwd = tempWorkspace();
    const source = createJobStore(cwd).create({
      kind,
      task: "Parent task",
      request: { ...template, cwd }
    });
    updateJob(cwd, source.id, { status: "blocked", sessionId: "ses_parent" });

    const receipt = await mimoResume({ cwd, jobId: source.id, task: "Continue" }, {
      env: {}, spawnJobSupervisor: vi.fn().mockReturnValue(123)
    });

    expect(readJob(cwd, receipt.jobId)?.request).toMatchObject({ executionPolicy: expected });
  });

  it("preserves the original policy across recursive resumes", async () => {
    const cwd = tempWorkspace();
    const source = createJobStore(cwd).create({
      kind: "plan",
      task: "Plan",
      request: { cwd, task: "Plan" }
    });
    updateJob(cwd, source.id, { status: "blocked", sessionId: "ses_parent" });
    const first = await mimoResume({ cwd, jobId: source.id, task: "Continue once" }, {
      env: {}, spawnJobSupervisor: vi.fn().mockReturnValue(123)
    });
    updateJob(cwd, first.jobId, { status: "blocked", sessionId: "ses_child" });

    const second = await mimoResume({ cwd, jobId: first.jobId, task: "Continue twice" }, {
      env: {}, spawnJobSupervisor: vi.fn().mockReturnValue(123)
    });

    expect(readJob(cwd, second.jobId)?.request).toMatchObject({
      executionPolicy: { agent: "plan", writesAllowed: false }
    });
  });

  it("does not expose a public write-policy override", async () => {
    const cwd = tempWorkspace();
    const source = createJobStore(cwd).create({
      kind: "plan",
      task: "Plan",
      request: { cwd, task: "Plan" }
    });
    updateJob(cwd, source.id, { status: "blocked", sessionId: "ses_parent" });

    await expect(mimoResume({
      cwd,
      jobId: source.id,
      task: "Continue",
      allowWrite: true
    }, { env: {}, spawnJobSupervisor: vi.fn().mockReturnValue(123) })).rejects.toThrow();
  });
});
