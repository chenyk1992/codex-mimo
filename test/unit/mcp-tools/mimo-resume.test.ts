import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mimoResume } from "../../../src/codex/tools.js";
import { readJobCheckpoint, writeJobCheckpoint } from "../../../src/core/job-checkpoint.js";
import {
  createJobChainFromManifest,
  markSliceRunning,
  markSliceTerminal,
  readJobChain,
  resolveSliceManifestPath,
  writeSliceManifestArtifact
} from "../../../src/core/job-chain.js";
import { getJobDefinition } from "../../../src/core/job-definitions.js";
import { createJobStore, listJobs, readJob, updateJob, updateJobAuthoritative } from "../../../src/core/job-store.js";
import { disposeGitExecutionWorkspace, preparePersistentGitWorktree } from "../../../src/git/worktree.js";
import type { ExecutionWorkspaceLease, JobRecord } from "../../../src/core/jobs.js";
import type { SliceManifest } from "../../../src/compose/slices.js";

const ACTIVE_SIGNAL = new AbortController().signal;

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
      const prepareCodex = vi.fn().mockResolvedValue({ probe: { ok: true, source: "path" } });

      const receipt = await mimoResume({ cwd, jobId: source.id, task: "Continue" }, {
        env: { CODEX_THREAD_ID: "thread-drifted" }, spawnJobSupervisor, prepareCodex
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
      expect(prepareCodex).toHaveBeenCalledWith({
        env: { CODEX_THREAD_ID: "thread-drifted" },
        threadId: "thread-parent"
      });
      expect(spawnJobSupervisor).toHaveBeenCalledWith(cwd);
    });

  it("preflights an inherited Codex target and creates no child on failure", async () => {
    const cwd = tempWorkspace();
    const source = parent(cwd);
    const spawnJobSupervisor = vi.fn();
    const before = artifactPaths(cwd);
    const prepareCodex = vi.fn().mockResolvedValue({
      probe: { ok: false, source: "path", errorCode: "codex_thread_forbidden" }
    });

    await expect(mimoResume({ cwd, jobId: source.id, task: "Continue" }, {
      env: {},
      prepareCodex,
      spawnJobSupervisor
    })).rejects.toThrow(
      "Codex notification preflight failed: codex_thread_forbidden. The selected Codex task is not accessible from this Codex session. Open the target task in Codex Desktop and retry with a task you can access."
    );

    expect(prepareCodex).toHaveBeenCalledWith({ env: {}, threadId: "thread-parent" });
    expect(spawnJobSupervisor).not.toHaveBeenCalled();
    expect(listJobs(cwd).map((job) => job.id)).toEqual([source.id]);
    expect(artifactPaths(cwd)).toEqual(before);
  });

  it("uses an explicit notification override instead of the parent target", async () => {
    const cwd = tempWorkspace();
    const source = parent(cwd);
    const prepareCodex = vi.fn();
    const receipt = await mimoResume({
      cwd,
      jobId: source.id,
      task: "Continue",
      notify: { type: "webhook", url: "https://example.test/hook", secretEnv: "HOOK_SECRET" }
    }, { env: {}, spawnJobSupervisor: vi.fn().mockReturnValue(123), prepareCodex });

    expect(prepareCodex).not.toHaveBeenCalled();
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
    ["completed", "ses_parent", "is not in a resumable state"],
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

  it("resumes a completed persistent Compose parent with its exact private worktree lease", async () => {
    const { cwd, lease, prepared, source } = persistentComposeParent();
    try {
      const receipt = await mimoResume({ cwd, jobId: source.id, task: "Continue worktree changes" }, {
        env: {}, spawnJobSupervisor: vi.fn().mockReturnValue(123)
      });

      expect(readJob(cwd, receipt.jobId)).toMatchObject({
        kind: "resume",
        parentJobId: source.id,
        executionWorkspaceLease: lease
      });
    } finally {
      disposeGitExecutionWorkspace(prepared);
    }
  });

  it("fails closed before creating a child when a completed persistent Compose lease no longer matches disk ownership", async () => {
    const { cwd, lease, prepared, source } = persistentComposeParent();
    try {
      updateJob(cwd, source.id, {
        executionWorkspaceLease: { ...lease, ownerToken: crypto.randomUUID() }
      });

      await expect(mimoResume({ cwd, jobId: source.id, task: "Continue worktree changes" }, {
        env: {}, spawnJobSupervisor: vi.fn()
      })).rejects.toThrow("persistent_worktree_unavailable");
      expect(listJobs(cwd).map((job) => job.id)).toEqual([source.id]);
    } finally {
      disposeGitExecutionWorkspace(prepared);
    }
  });

  it.each([
    ["plan", { task: "Plan", cwd: "" }, { agent: "codex-mimo-readonly", writesAllowed: false }],
    ["review", { base: "HEAD", cwd: "" }, { agent: "codex-mimo-readonly", writesAllowed: false }],
    ["compose", { workflow: "plan", task: "Plan", cwd: "" }, { agent: "codex-mimo-readonly", writesAllowed: false }],
    ["compose", { workflow: "dev", task: "Build", cwd: "" }, { agent: "build", writesAllowed: true }]
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
    expect(readJob(cwd, receipt.jobId)?.request).toMatchObject({
      executionPolicy: { writesAllowed: expected.writesAllowed }
    });
  });

  it.each([
    ["plan", { task: "Plan", cwd: "" }, false],
    ["compose", { workflow: "dev", task: "Build", cwd: "" }, true]
  ] as const)(
    "preserves resumed %s parent writesAllowed=%s without caller override",
    async (kind, template, writesAllowed) => {
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

      const child = readJob(cwd, receipt.jobId);
      expect(child?.request).toEqual(expect.objectContaining({
        executionPolicy: expect.objectContaining({ writesAllowed })
      }));
    }
  );

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
      executionPolicy: { agent: "codex-mimo-readonly", writesAllowed: false }
    });
  });

  it("inherits development acceptance and write scope into the resume request", async () => {
    const cwd = tempWorkspace();
    const source = createJobStore(cwd).create({
      kind: "implement",
      task: "Build feature",
      request: {
        cwd,
        task: "Build feature",
        allowWrite: true,
        acceptance: {
          build: ["npm run build"],
          test: ["npm test"],
          diffCheck: true,
          artifactPaths: ["out/**"]
        },
        allowedPaths: ["src/**"]
      }
    });
    updateJob(cwd, source.id, {
      status: "blocked",
      sessionId: "ses_parent",
      summary: "Need input."
    });

    const receipt = await mimoResume({ cwd, jobId: source.id, task: "Continue" }, {
      env: {},
      spawnJobSupervisor: vi.fn().mockReturnValue(123)
    });

    expect(readJob(cwd, receipt.jobId)?.request).toMatchObject({
      requireAcceptance: true,
      acceptance: {
        build: ["npm run build"],
        test: ["npm test"],
        diffCheck: true,
        artifactPaths: ["out/**"]
      },
      allowedPaths: ["src/**"]
    });
  });

  it("overrides inherited acceptance field-by-field and replaces write scope", async () => {
    const cwd = tempWorkspace();
    const source = createJobStore(cwd).create({
      kind: "implement",
      task: "Build feature",
      request: {
        cwd,
        task: "Build feature",
        allowWrite: true,
        acceptance: {
          build: ["npm run old-build"],
          test: ["npm run old-test"],
          diffCheck: true
        },
        allowedPaths: ["src/old/**"]
      }
    });
    updateJob(cwd, source.id, {
      status: "blocked",
      sessionId: "ses_parent",
      summary: "Need input."
    });

    const receipt = await mimoResume({
      cwd,
      jobId: source.id,
      task: "Continue",
      acceptance: {
        test: ["npm run new-test"],
        diffCheck: false,
        artifactPaths: ["coverage/**"]
      },
      allowedPaths: ["src/new/**"]
    }, {
      env: {},
      spawnJobSupervisor: vi.fn().mockReturnValue(123)
    });

    expect(readJob(cwd, receipt.jobId)?.request).toMatchObject({
      requireAcceptance: true,
      acceptance: {
        build: ["npm run old-build"],
        test: ["npm run new-test"],
        diffCheck: false,
        artifactPaths: ["coverage/**"]
      },
      allowedPaths: ["src/new/**"]
    });
  });

  it("rejects an acceptance override that overlaps the inherited write scope", async () => {
    const cwd = tempWorkspace();
    const source = createJobStore(cwd).create({
      kind: "implement",
      task: "Build feature",
      request: {
        cwd,
        task: "Build feature",
        allowWrite: true,
        acceptance: {
          build: ["npm run build"],
          test: ["npm test"]
        },
        allowedPaths: ["src/**"]
      }
    });
    updateJob(cwd, source.id, {
      status: "blocked",
      sessionId: "ses_parent"
    });

    await expect(mimoResume({
      cwd,
      jobId: source.id,
      task: "Continue",
      acceptance: { artifactPaths: ["src/generated/**"] }
    }, {
      env: {},
      spawnJobSupervisor: vi.fn().mockReturnValue(123)
    })).rejects.toThrow(/must not overlap/);
  });

  it("resumes acceptance_config_missing without a prior session when acceptance is supplied", async () => {
    const cwd = tempWorkspace();
    const source = createJobStore(cwd).create({
      kind: "fix-ci",
      task: "Fix CI",
      request: { cwd, file: "ci.log" }
    });
    updateJob(cwd, source.id, {
      status: "needs_input",
      errorCode: "acceptance_config_missing",
      summary: "Acceptance is required."
    });

    const receipt = await mimoResume({
      cwd,
      jobId: source.id,
      acceptance: {
        build: ["npm run build"],
        test: ["npm test"],
        diffCheck: true
      }
    }, {
      env: {},
      spawnJobSupervisor: vi.fn().mockReturnValue(123)
    });

    expect(readJob(cwd, receipt.jobId)?.request).toMatchObject({
      task: "Fix CI",
      requireAcceptance: true,
      acceptance: {
        build: ["npm run build"],
        test: ["npm test"],
        diffCheck: true
      }
    });
    expect(readJob(cwd, receipt.jobId)?.request).not.toHaveProperty("sessionId");
  });

  it("resumes a stalled parent with session reuse", async () => {
    const cwd = tempWorkspace();
    const source = await stalledParent(cwd, { sessionId: "ses_stalled" });
    const spawnJobSupervisor = vi.fn().mockReturnValue(123);

    const receipt = await mimoResume({ cwd, jobId: source.id }, {
      env: {}, spawnJobSupervisor,
      verifyProcess: () => ({ status: "not_running" as const, evidence: "gone" }),
      captureFingerprint: async () => source.checkpoint!.repositoryFingerprint
    });

    const child = readJob(cwd, receipt.jobId)!;
    expect(child.parentJobId).toBe(source.id);
    expect(child.request).toMatchObject({ sessionId: "ses_stalled" });
  });

  it("does not reject resume when only codex-mimo runtime files changed", async () => {
    const cwd = tempWorkspace();
    const source = await stalledParent(cwd, { sessionId: "ses_runtime" });
    fs.mkdirSync(path.join(cwd, ".codex-mimo", "jobs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".codex-mimo", "jobs", "worker.log"), "later", "utf8");

    const receipt = await mimoResume({ cwd, jobId: source.id }, {
      env: {},
      spawnJobSupervisor: vi.fn().mockReturnValue(123),
      verifyProcess: () => ({ status: "not_running" as const, evidence: "gone" })
    });

    expect(readJob(cwd, receipt.jobId)?.parentJobId).toBe(source.id);
  });

  it("resumes timeout without session using checkpoint-only prompt", async () => {
    const cwd = tempWorkspace();
    const source = await stalledParent(cwd, { status: "timeout", sessionId: null });
    const spawnJobSupervisor = vi.fn().mockReturnValue(123);

    await mimoResume({ cwd, jobId: source.id }, {
      env: {}, spawnJobSupervisor,
      verifyProcess: () => ({ status: "not_running" as const, evidence: "gone" }),
      captureFingerprint: async () => source.checkpoint!.repositoryFingerprint
    });

    const child = readJob(cwd, listJobs(cwd).find((job) => job.kind === "resume")!.id)!;
    expect(child.request).not.toHaveProperty("sessionId");
    const prompt = await getJobDefinition("resume").buildPrompt(
      child.request as never,
      ACTIVE_SIGNAL
    );
    const promptText = fs.readFileSync(prompt.files[0], "utf-8");
    expect(promptText).toMatch(/Do not perform a broad project scan/i);
    expect(promptText).toContain("src/feature.ts");
    expect(promptText).toContain("remainingChecklist");
  });

  it("rejects resume when process still alive or fingerprint conflicts", async () => {
    const cwd = tempWorkspace();
    const alive = createJobStore(cwd).create({
      kind: "implement",
      task: "Build feature",
      request: { cwd, task: "Build feature", allowWrite: true }
    });
    updateJob(cwd, alive.id, {
      status: "blocked",
      errorCode: "stalled_process_alive",
      sessionId: "ses_alive",
      summary: "Process still running."
    });
    await expect(mimoResume({ cwd, jobId: alive.id, task: "Continue" }, {
      env: {}, spawnJobSupervisor: vi.fn()
    })).rejects.toThrow(/not resumable|stalled_process_alive/i);

    const conflict = await stalledParent(cwd, { sessionId: "ses_conflict" });
    await expect(mimoResume({ cwd, jobId: conflict.id }, {
      env: {}, spawnJobSupervisor: vi.fn(),
      verifyProcess: () => ({ status: "not_running" as const, evidence: "gone" }),
      captureFingerprint: async () => "different-fingerprint"
    })).rejects.toThrow(/resume_conflict/i);
  });

  it("still requires a task when resuming blocked", async () => {
    const cwd = tempWorkspace();
    const source = createJobStore(cwd).create({
      kind: "plan",
      task: "Plan",
      request: { cwd, task: "Plan" }
    });
    updateJob(cwd, source.id, { status: "blocked", sessionId: "ses_parent" });
    await expect(mimoResume({ cwd, jobId: source.id }, {
      env: {}, spawnJobSupervisor: vi.fn().mockReturnValue(123)
    })).rejects.toThrow(/task/i);
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

  it("resumes a mid-chain root attention on the current failed slice and skips completed slices", async () => {
    const cwd = tempWorkspace();
    const { root, chainId, stalledChild, checkpointFingerprint } = await midChainStalledRoot(cwd);
    const spawnJobSupervisor = vi.fn().mockReturnValue(123);

    const receipt = await mimoResume({ cwd, jobId: root.id }, {
      env: {},
      spawnJobSupervisor,
      verifyProcess: () => ({ status: "not_running" as const, evidence: "gone" }),
      captureFingerprint: async () => checkpointFingerprint
    });

    const continuation = readJob(cwd, receipt.jobId)!;
    expect(continuation).toMatchObject({
      kind: "resume",
      parentJobId: root.id,
      chainId,
      sliceId: "slice-2"
    });
    expect(continuation.notificationTarget == null).toBe(true);
    expect(continuation.request).toMatchObject({
      sessionId: "ses_slice_2",
      checkpoint: expect.objectContaining({
        completedSlices: ["slice-1"],
        chainId
      })
    });
    expect(readJobChain(cwd, chainId)).toMatchObject({
      sliceStates: { "slice-1": "completed", "slice-2": "running" },
      latestContinuationJobId: continuation.id,
      completedSliceIds: ["slice-1"]
    });
    expect(readJob(cwd, root.id)).toMatchObject({ status: "running" });
    expect(listJobs(cwd).some((job) => job.sliceId === "slice-1" && job.kind === "resume")).toBe(false);
    expect(stalledChild.id).not.toBe(continuation.id);
  });

  it("inherits the root acceptance contract when a legacy chain child omitted it", async () => {
    const cwd = tempWorkspace();
    const { root, stalledChild, checkpointFingerprint } = await midChainStalledRoot(cwd);
    updateJob(cwd, stalledChild.id, {
      request: {
        cwd,
        task: stalledChild.task,
        allowWrite: true,
        batchMode: "single"
      }
    });

    const receipt = await mimoResume({ cwd, jobId: root.id }, {
      env: {},
      spawnJobSupervisor: vi.fn().mockReturnValue(123),
      verifyProcess: () => ({ status: "not_running" as const, evidence: "gone" }),
      captureFingerprint: async () => checkpointFingerprint
    });

    expect(readJob(cwd, receipt.jobId)?.request).toMatchObject({
      requireAcceptance: true,
      acceptance: {
        build: ["npm run build"],
        test: ["npm test -- focused.test.ts"]
      }
    });
  });

  it("keeps resume_conflict when mid-chain fingerprint drifts", async () => {
    const cwd = tempWorkspace();
    const { root } = await midChainStalledRoot(cwd);
    await expect(mimoResume({ cwd, jobId: root.id }, {
      env: {},
      spawnJobSupervisor: vi.fn(),
      verifyProcess: () => ({ status: "not_running" as const, evidence: "gone" }),
      captureFingerprint: async () => "different-fingerprint"
    })).rejects.toThrow(/resume_conflict/i);
  });
});

async function stalledParent(
  cwd: string,
  patch: Partial<JobRecord> & { status?: "stalled" | "timeout" } = {}
): Promise<JobRecord & { checkpoint: NonNullable<ReturnType<typeof readJobCheckpoint>> }> {
  const record = createJobStore(cwd).create({
    kind: "implement",
    task: "Build feature",
    request: { cwd, task: "Build feature", allowWrite: true }
  });
  const base = updateJob(cwd, record.id, {
    status: patch.status ?? "stalled",
    sessionId: patch.sessionId === null ? null : (patch.sessionId ?? "ses_stalled"),
    summary: "Stalled waiting for progress.",
    changedFiles: ["src/feature.ts"],
    lastCommand: "npm test",
    ...patch
  });
  const paths = await writeJobCheckpoint({
    job: base,
    objective: base.task,
    changedFiles: base.changedFiles,
    contextFiles: ["src/feature.ts"],
    captureHead: async () => ({ oid: "abc123", branch: "main" }),
    captureStatus: async () => ({
      short: "",
      dirty: false,
      fingerprints: { "src/feature.ts": { status: " M", contentHash: "hash-feature" } }
    })
  });
  updateJob(cwd, base.id, { reportPaths: paths });
  const checkpoint = readJobCheckpoint(paths.checkpoint!)!;
  return { ...readJob(cwd, base.id)!, checkpoint };
}

async function midChainStalledRoot(cwd: string): Promise<{
  root: JobRecord;
  chainId: string;
  stalledChild: JobRecord;
  checkpointFingerprint: string;
}> {
  const acceptance = {
    build: ["npm run build"],
    test: ["npm test -- focused.test.ts"]
  };
  const store = createJobStore(cwd);
  const root = store.create({
    kind: "implement",
    task: "Build feature",
    request: {
      cwd,
      task: "Build feature",
      allowWrite: true,
      acceptance,
      batchMode: "sliced"
    },
    notificationTarget: { type: "codex", threadId: "thread-root" }
  });
  const chainId = `chain-${root.id}`;
  const manifest: SliceManifest = {
    version: 1,
    chainId,
    objective: "Build feature",
    repositoryFingerprint: "fp-root",
    slices: [
      {
        id: "slice-1",
        title: "Slice 1",
        objective: "First slice",
        dependsOn: [],
        contextFiles: ["src/a.ts"],
        allowedPaths: ["src/a.ts"],
        acceptance
      },
      {
        id: "slice-2",
        title: "Slice 2",
        objective: "Second slice",
        dependsOn: ["slice-1"],
        contextFiles: ["src/b.ts"],
        allowedPaths: ["src/b.ts"],
        acceptance
      }
    ]
  };
  const manifestPath = writeSliceManifestArtifact({ cwd, rootJobId: root.id, manifest });
  createJobChainFromManifest({ cwd, rootJobId: root.id, manifest, manifestPath });
  const first = store.create({
    kind: "implement",
    task: "First slice",
    request: { cwd, task: "First slice", allowWrite: true, acceptance, batchMode: "single" },
    parentJobId: root.id,
    chainId,
    sliceId: "slice-1"
  });
  markSliceRunning(cwd, chainId, "slice-1", first.id);
  markSliceTerminal(cwd, chainId, "slice-1", "completed");
  const second = store.create({
    kind: "implement",
    task: "Second slice",
    request: { cwd, task: "Second slice", allowWrite: true, acceptance, batchMode: "single" },
    parentJobId: root.id,
    chainId,
    sliceId: "slice-2"
  });
  markSliceRunning(cwd, chainId, "slice-2", second.id);
  updateJob(cwd, second.id, {
    status: "stalled",
    sessionId: "ses_slice_2",
    summary: "Slice 2 stalled.",
    changedFiles: ["src/b.ts"],
    errorCode: "no_effective_progress"
  });
  markSliceTerminal(cwd, chainId, "slice-2", "stalled");
  await updateJobAuthoritative(cwd, root.id, {
    status: "stalled",
    chainId,
    summary: "Slice slice-2 stalled.",
    error: "Slice slice-2 stalled.",
    errorCode: "no_effective_progress",
    changedFiles: ["src/a.ts", "src/b.ts"],
    reportPaths: { slices: resolveSliceManifestPath(cwd, root.id).replace(/\\/g, "/") }
  });
  const rootAfter = readJob(cwd, root.id)!;
  const paths = await writeJobCheckpoint({
    job: rootAfter,
    objective: rootAfter.task,
    changedFiles: rootAfter.changedFiles,
    contextFiles: ["src/a.ts", "src/b.ts"],
    completedSlices: ["slice-1"],
    captureHead: async () => ({ oid: "abc123", branch: "main" }),
    captureStatus: async () => ({
      short: "",
      dirty: false,
      fingerprints: {
        "src/a.ts": { status: " M", contentHash: "hash-a" },
        "src/b.ts": { status: " M", contentHash: "hash-b" }
      }
    })
  });
  await updateJobAuthoritative(cwd, root.id, { reportPaths: { ...rootAfter.reportPaths, ...paths } });
  const checkpoint = readJobCheckpoint(paths.checkpoint!)!;
  expect(readJobChain(cwd, chainId)?.completedSliceIds).toEqual(["slice-1"]);
  return {
    root: readJob(cwd, root.id)!,
    chainId,
    stalledChild: readJob(cwd, second.id)!,
    checkpointFingerprint: checkpoint.repositoryFingerprint
  };
}

function artifactPaths(cwd: string): string[] {
  const root = path.join(cwd, ".codex-mimo");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true })
    .map((entry) => String(entry).replaceAll("\\", "/"))
    .sort();
}

function persistentComposeParent(): {
  cwd: string;
  lease: ExecutionWorkspaceLease;
  prepared: ReturnType<typeof preparePersistentGitWorktree>;
  source: JobRecord;
} {
  const cwd = tempWorkspace();
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd, stdio: "ignore" });
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".codex-mimo/\n");
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "initial\n");
  execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd, stdio: "ignore" });
  const source = createJobStore(cwd).create({
    kind: "compose",
    task: "Run worktree workflow",
    request: { cwd, task: "Run worktree workflow", workflow: "worktree" }
  });
  const prepared = preparePersistentGitWorktree(cwd, source.id, { base: tempWorkspace() });
  const { baseline: _baseline, ...lease } = prepared;
  return {
    cwd,
    lease,
    prepared,
    source: updateJob(cwd, source.id, {
      status: "completed",
      executionWorkspaceLease: lease
    })
  };
}
