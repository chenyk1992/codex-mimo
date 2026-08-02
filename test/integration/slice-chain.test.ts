import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mimoResult, mimoResume } from "../../src/codex/tools.js";
import type { SliceManifest } from "../../src/compose/slices.js";
import { listJobs, createJobStore, readJob, updateJob } from "../../src/core/job-store.js";
import { readJobChain } from "../../src/core/job-chain.js";
import { runJobWorker, type JobWorkerDependencies } from "../../src/core/job-worker.js";
import { createHookCallbackController } from "../../src/mimo/hook-callback.js";
import { runMimoCliStreaming } from "../../src/mimo/streaming-runner.js";
import { readDeliveries } from "../../src/notify/outbox.js";

const workspaces: string[] = [];
const children = new Set<ChildProcess>();
const fakeMimo = path.resolve("test/fixtures/fake-mimo.mjs");

const PASSING_ACCEPTANCE = {
  build: ["node -e process.exit(0)"],
  test: ["node -e process.exit(0)"],
  diffCheck: false as const
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of [...children]) {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        if (process.platform === "win32") {
          execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true
          });
        } else {
          child.kill("SIGKILL");
        }
      } catch {}
    }
    children.delete(child);
  }
  for (const cwd of workspaces.splice(0)) {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-slice-chain-"));
  workspaces.push(cwd);
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd });
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "initial\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd });
  execFileSync("git", ["commit", "-m", "initial"], { cwd, stdio: "ignore" });
  return cwd;
}

function twoSliceManifest(chainId: string): SliceManifest {
  return {
    version: 1,
    chainId,
    objective: "Implement two-slice feature",
    repositoryFingerprint: "fp-integration",
    slices: [
      {
        id: "slice-1",
        title: "Slice 1",
        objective: "Do work for slice-1",
        dependsOn: [],
        contextFiles: ["tracked.txt"],
        allowedPaths: ["tracked.txt"],
        acceptance: PASSING_ACCEPTANCE
      },
      {
        id: "slice-2",
        title: "Slice 2",
        objective: "Do work for slice-2",
        dependsOn: ["slice-1"],
        contextFiles: ["tracked.txt"],
        allowedPaths: ["tracked.txt"],
        acceptance: PASSING_ACCEPTANCE
      }
    ]
  };
}

function workerDependencies(input: {
  mode?: "complete" | "hang";
  callback?: boolean;
  callbackWaitMs?: number;
} = {}): JobWorkerDependencies {
  const mode = input.mode ?? "complete";
  const callback = input.callback ?? true;
  return {
    createHookCallbackController: (hookInput) => createHookCallbackController({
      ...hookInput,
      callbackWaitMs: input.callbackWaitMs ?? 100
    }),
    captureProcessIdentity: (pid) => ({
      status: "running",
      identity: `fake-process:${pid}`,
      evidence: "slice-chain fixture"
    }),
    spawnNotificationWorker: () => 999,
    runMimoStreaming: (cwd, args, options) => {
      const fakeEnv = {
        ...options.env,
        FAKE_MIMO_MODE: mode,
        FAKE_MIMO_CALLBACK: callback ? "1" : "0",
        FAKE_MIMO_FINAL_TEXT: "Slice work completed from fake MiMo."
      };
      return runMimoCliStreaming(cwd, args, {
        ...options,
        env: fakeEnv,
        allowEnv: [...(options.allowEnv ?? []), ...Object.keys(fakeEnv).filter((name) => name.startsWith("FAKE_MIMO_"))],
        spawnProcess: (spawnCwd, _mimoArgs, env) => {
          const child = spawn(process.execPath, [fakeMimo], {
            cwd: spawnCwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true
          });
          children.add(child);
          child.once("exit", () => children.delete(child));
          return child;
        },
        terminateProcessTree: async (_pid, child) => { child.kill(); }
      });
    }
  };
}

async function runFakeWithDeps(
  cwd: string,
  jobId: string,
  options: Parameters<typeof workerDependencies>[0] = {},
  extraDeps: Partial<JobWorkerDependencies> = {}
) {
  await runJobWorker(cwd, jobId, { ...workerDependencies(options), ...extraDeps });
  return readJob(cwd, jobId)!;
}

describe("slice chain integration", () => {
  it("runs two slices sequentially, stalls mid-chain, resumes skipping completed, and aggregates on the root", async () => {
    const cwd = workspace();
    const root = createJobStore(cwd).create({
      kind: "implement",
      task: "Implement two-slice feature",
      request: {
        cwd,
        task: "Implement two-slice feature",
        allowWrite: true,
        acceptance: PASSING_ACCEPTANCE,
        batchMode: "sliced",
        idleTimeoutMs: 0,
        timeoutMs: 60_000
      },
      notificationTarget: { type: "codex", threadId: "thread-slice-root" }
    });

    await runFakeWithDeps(cwd, root.id, { mode: "complete" }, {
      chainBootstrap: {
        spawnJobSupervisor: () => 1,
        captureRepositoryFingerprint: async () => "fp-integration",
        planSliceManifest: async (input) => ({
          ok: true,
          manifest: twoSliceManifest(input.chainId)
        })
      }
    });

    const bootstrapped = readJob(cwd, root.id)!;
    expect(bootstrapped).toMatchObject({
      status: "running",
      chainId: `chain-${root.id}`
    });
    expect(bootstrapped.reportPaths?.slices).toBeTruthy();
    expect(fs.existsSync(bootstrapped.reportPaths!.slices!)).toBe(true);
    expect(readJobChain(cwd, bootstrapped.chainId!)).toMatchObject({
      rootJobId: root.id,
      sliceStates: { "slice-1": "running", "slice-2": "pending" }
    });

    const firstChild = listJobs(cwd).find((job) => job.sliceId === "slice-1");
    expect(firstChild).toBeTruthy();
    expect(firstChild!.notificationTarget).toBeUndefined();
    expect(firstChild!.parentJobId).toBe(root.id);

    const completedFirst = await runFakeWithDeps(cwd, firstChild!.id, { mode: "complete" }, {
      chainAdvance: { spawnJobSupervisor: () => 1 }
    });
    expect(completedFirst.status).toBe("completed");
    expect(readDeliveries(completedFirst.notificationOutboxFile).filter(
      (delivery) => delivery.jobId === completedFirst.id
    )).toHaveLength(0);

    const afterFirstRoot = readJob(cwd, root.id)!;
    expect(afterFirstRoot.status).toBe("running");
    expect(readDeliveries(afterFirstRoot.notificationOutboxFile).filter(
      (delivery) => delivery.jobId === afterFirstRoot.id
    )).toHaveLength(0);
    const chainId = afterFirstRoot.chainId!;
    expect(readJobChain(cwd, chainId)).toMatchObject({
      completedSliceIds: ["slice-1"],
      sliceStates: { "slice-1": "completed", "slice-2": "running" }
    });

    const secondChild = listJobs(cwd).find(
      (job) => job.sliceId === "slice-2" && job.kind === "implement"
    );
    expect(secondChild).toBeTruthy();
    expect(secondChild!.notificationTarget).toBeUndefined();

    // Short progress budget only on the hanging slice so slice 1 can complete normally.
    updateJob(cwd, secondChild!.id, {
      progressTimeoutMs: 150,
      progressWarningMs: 50,
      request: {
        ...(secondChild!.request as Record<string, unknown>),
        progressTimeoutMs: 150,
        progressWarningMs: 50,
        idleTimeoutMs: 0
      }
    });

    const stalledSecond = await runFakeWithDeps(cwd, secondChild!.id, {
      mode: "hang",
      callback: false,
      callbackWaitMs: 20
    }, {
      progressMonitorPollMs: 25,
      chainAdvance: { spawnJobSupervisor: () => 1 }
    });
    expect(stalledSecond.status).toBe("stalled");
    expect(readDeliveries(stalledSecond.notificationOutboxFile).filter(
      (delivery) => delivery.jobId === stalledSecond.id
    )).toHaveLength(0);

    const stalledRoot = readJob(cwd, root.id)!;
    expect(stalledRoot.status).toBe("stalled");
    expect(stalledRoot.reportPaths?.checkpoint).toBeTruthy();
    expect(fs.existsSync(stalledRoot.reportPaths!.checkpoint!)).toBe(true);

    const rootDeliveriesAfterStall = readDeliveries(stalledRoot.notificationOutboxFile);
    expect(rootDeliveriesAfterStall.some((delivery) => delivery.jobId === root.id)).toBe(true);
    expect(rootDeliveriesAfterStall.every((delivery) => delivery.jobId === root.id)).toBe(true);

    const compactStalled = await mimoResult({ cwd, jobId: root.id });
    expect(Buffer.byteLength(JSON.stringify(compactStalled), "utf8")).toBeLessThanOrEqual(6000);
    expect(compactStalled).toMatchObject({
      status: "stalled",
      attention: {
        kind: "stalled",
        resume: { tool: "mimo_resume", jobId: root.id }
      }
    });

    const standardMid = await mimoResult({ cwd, jobId: root.id, level: "standard" });
    expect(standardMid).toMatchObject({
      completedSlices: 1,
      remainingSlices: 1
    });

    const checkpoint = JSON.parse(
      fs.readFileSync(stalledRoot.reportPaths!.checkpoint!, "utf8")
    ) as { repositoryFingerprint: string; completedSlices?: string[] };
    expect(checkpoint.completedSlices).toEqual(["slice-1"]);

    const receipt = await mimoResume({ cwd, jobId: root.id, task: "Continue slice 2" }, {
      env: {},
      spawnJobSupervisor: () => 123,
      verifyProcess: () => ({ status: "not_running" as const, evidence: "gone" }),
      captureFingerprint: async () => checkpoint.repositoryFingerprint
    });
    expect(receipt.kind).toBe("resume");

    const continuation = readJob(cwd, receipt.jobId)!;
    expect(continuation).toMatchObject({
      kind: "resume",
      parentJobId: root.id,
      chainId,
      sliceId: "slice-2"
    });
    expect(continuation.notificationTarget == null).toBe(true);
    expect(listJobs(cwd).some((job) => job.sliceId === "slice-1" && job.kind === "resume")).toBe(false);

    const completedResume = await runFakeWithDeps(cwd, continuation.id, { mode: "complete" }, {
      chainAdvance: { spawnJobSupervisor: () => 1 }
    });
    expect(completedResume.status).toBe("completed");
    expect(readDeliveries(completedResume.notificationOutboxFile).filter(
      (delivery) => delivery.jobId === completedResume.id
    )).toHaveLength(0);

    const completedRoot = readJob(cwd, root.id)!;
    expect(completedRoot.status).toBe("completed");
    expect(readJobChain(cwd, chainId)).toMatchObject({
      completedSliceIds: ["slice-1", "slice-2"],
      sliceStates: { "slice-1": "completed", "slice-2": "completed" }
    });

    const compactDone = await mimoResult({ cwd, jobId: root.id });
    expect(Buffer.byteLength(JSON.stringify(compactDone), "utf8")).toBeLessThanOrEqual(6000);
    expect(compactDone.status).toBe("completed");

    const standardDone = await mimoResult({ cwd, jobId: root.id, level: "standard" });
    expect(standardDone).toMatchObject({
      status: "completed",
      completedSlices: 2,
      remainingSlices: 0
    });

    const allDeliveries = readDeliveries(completedRoot.notificationOutboxFile);
    expect(allDeliveries.length).toBeGreaterThan(0);
    expect(allDeliveries.every((delivery) => delivery.jobId === root.id)).toBe(true);
  }, 30_000);
});
