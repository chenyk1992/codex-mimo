import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoundJobDefinition } from "../../../src/core/job-definitions.js";
import { runJobWorker, type JobWorkerDependencies } from "../../../src/core/job-worker.js";
import { readJob, createJobStore } from "../../../src/core/job-store.js";
import { transitionJob } from "../../../src/core/job-transition.js";
import type { JobKind, JobRecord } from "../../../src/core/jobs.js";
import { readJobSignals } from "../../../src/core/job-signals.js";
import { readDeliveries } from "../../../src/notify/outbox.js";
import type { HookCallbackController, MimoHookCallbackSummary } from "../../../src/mimo/hook-callback.js";
import type { StreamingRunOptions, StreamingRunResult } from "../../../src/mimo/streaming-runner.js";

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-worker-"));
  tempDirs.push(cwd);
  return cwd;
}

function gitWorkspace(): string {
  const cwd = tempWorkspace();
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "worker@example.test"], { cwd });
  execFileSync("git", ["config", "user.name", "Worker Test"], { cwd });
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "before\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd });
  execFileSync("git", ["commit", "-m", "base"], { cwd, stdio: "ignore" });
  return cwd;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const cwd of tempDirs.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

const completedCallback: MimoHookCallbackSummary = {
  invocationId: "inv-worker",
  event: "session.post",
  receivedAt: "2026-07-16T00:00:00.000Z",
  outcome: "completed",
  sessionId: "ses_worker",
  finalText: "Implemented and verified."
};

const completedRun: StreamingRunResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  pid: 321
};

function seedJob(cwd: string, kind: JobKind, notify = false): JobRecord {
  return createJobStore(cwd).create({
    kind,
    task: `Run ${kind}`,
    request: { cwd },
    ...(notify ? { notificationTarget: { type: "codex" as const, threadId: "thread-worker" } } : {})
  });
}

function seedActualImplementJob(cwd: string): JobRecord {
  return createJobStore(cwd).create({
    kind: "implement",
    task: "Implement it",
    request: { cwd, task: "Implement it", allowWrite: true }
  });
}

function hook(callback: MimoHookCallbackSummary | null = completedCallback): HookCallbackController {
  return {
    invocationId: "inv-worker",
    token: "token",
    endpoint: "http://127.0.0.1:1/mimo-hook",
    configDir: "hook-dir",
    callbackFile: "callback.json",
    env: { HOOK_ENV: "yes" },
    waitForCallback: vi.fn(async () => callback),
    close: vi.fn(async () => undefined)
  };
}

function definition(outcome: Partial<Awaited<ReturnType<BoundJobDefinition["finalize"]>>> = {}): BoundJobDefinition {
  return {
    kind: "implement",
    writesAllowed: true,
    buildPrompt: vi.fn(async () => ({ message: "prompt", files: [] })),
    buildMimoArgs: vi.fn(() => ["run", "--format", "json", "prompt"]),
    finalize: vi.fn(async (context) => ({
      status: "completed",
      summary: "Implemented and verified.",
      sessionId: context.executionCallback?.sessionId,
      executionCallback: context.executionCallback,
      verification: [],
      ...outcome
    }))
  };
}

function workerDeps(overrides: Partial<JobWorkerDependencies> = {}): JobWorkerDependencies {
  const bound = definition();
  const controller = hook();
  return {
    bindJobDefinition: vi.fn(() => bound),
    createHookCallbackController: vi.fn(async () => controller),
    runMimoStreaming: vi.fn(async (_cwd: string, _args: string[], options: StreamingRunOptions) => {
      await options.onStart?.(321);
      await options.onLine?.('{"type":"text","text":"Implemented and verified.","sessionID":"ses_worker"}');
      return completedRun;
    }),
    captureStatus: vi.fn(async () => ({ short: "", dirty: false, fingerprints: {} })),
    captureHead: vi.fn(async () => ({ oid: "abc", short: "abc", subject: "base" })),
    captureDiff: vi.fn(async () => ({ changedFiles: [], diffStat: "", diff: "" })),
    captureCommitChanges: vi.fn(async () => ({ commits: [], changedFiles: [] })),
    spawnNotificationWorker: vi.fn(() => 999),
    ...overrides
  };
}

describe("runJobWorker", () => {
  it.each(["plan", "implement", "review", "fix-ci", "resume", "compose"] as const)(
    "runs %s through the same lifecycle",
    async (kind) => {
      const cwd = tempWorkspace();
      const job = seedJob(cwd, kind);
      const deps = workerDeps();

      await runJobWorker(cwd, job.id, deps);

      expect(readJob(cwd, job.id)).toMatchObject({
        kind,
        status: "completed",
        pid: null,
        sessionId: "ses_worker"
      });
      expect(deps.runMimoStreaming).toHaveBeenCalledTimes(1);
      expect(deps.bindJobDefinition).toHaveBeenCalledWith(expect.objectContaining({ kind }));
    }
  );

  it("uses the shared default timeout when the stored request omits one", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "plan");
    const run = vi.fn(async () => completedRun);

    await runJobWorker(cwd, job.id, workerDeps({ runMimoStreaming: run }));

    expect(run).toHaveBeenCalledWith(
      cwd,
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 1_800_000 })
    );
  });

  it("does not report its own .codex-mimo runtime files as read-only writes", async () => {
    const cwd = gitWorkspace();
    const job = createJobStore(cwd).create({
      kind: "plan",
      task: "Plan it",
      request: { cwd, task: "Plan it" }
    });
    const deps = workerDeps();
    delete deps.bindJobDefinition;
    delete deps.captureStatus;
    delete deps.captureHead;
    delete deps.captureDiff;
    delete deps.captureCommitChanges;

    await runJobWorker(cwd, job.id, deps);

    expect(readJob(cwd, job.id)).toMatchObject({ status: "completed" });
  });

  it("fails a read-only job that changes a workspace file", async () => {
    const cwd = gitWorkspace();
    const job = createJobStore(cwd).create({
      kind: "plan",
      task: "Plan it",
      request: { cwd, task: "Plan it" }
    });
    const deps = workerDeps({
      runMimoStreaming: async (_cwd, _args, options) => {
        await options.onStart?.(654);
        fs.writeFileSync(path.join(cwd, "tracked.txt"), "after\n", "utf8");
        await options.onLine?.('{"type":"text","text":"Plan complete."}');
        return { ...completedRun, pid: 654 };
      }
    });
    delete deps.bindJobDefinition;
    delete deps.captureStatus;
    delete deps.captureHead;
    delete deps.captureDiff;
    delete deps.captureCommitChanges;

    await runJobWorker(cwd, job.id, deps);

    expect(readJob(cwd, job.id)).toMatchObject({
      status: "failed",
      errorCode: "read_only_violation",
      changedFiles: ["tracked.txt"]
    });
  });

  it.each([
    [null, "callback_missing"],
    [{ ...completedCallback, outcome: "error" as const, error: "hook failed" }, "callback_error"],
    [{ ...completedCallback, outcome: "cancelled" as const }, "callback_cancelled"]
  ])("maps unsuccessful callback %# to failed", async (callback, errorCode) => {
    const cwd = tempWorkspace();
    const job = seedActualImplementJob(cwd);
    const deps = workerDeps({
      createHookCallbackController: async () => hook(callback)
    });
    delete deps.bindJobDefinition;

    await runJobWorker(cwd, job.id, deps);

    expect(readJob(cwd, job.id)).toMatchObject({ status: "failed", errorCode });
  });

  it.each([
    ["process_timeout", "timeout"],
    ["user_cancelled", "cancelled"]
  ] as const)("maps %s to %s", async (terminationReason, status) => {
    const cwd = tempWorkspace();
    const job = seedActualImplementJob(cwd);
    const deps = workerDeps({
      runMimoStreaming: async () => ({ ...completedRun, exitCode: 124, terminationReason })
    });
    delete deps.bindJobDefinition;

    await runJobWorker(cwd, job.id, deps);

    expect(readJob(cwd, job.id)).toMatchObject({ status, pid: null });
  });

  it.each(["needs_input", "blocked", "failed"] as const)(
    "persists the %s outcome returned by finalization",
    async (status) => {
      const cwd = tempWorkspace();
      const job = seedJob(cwd, "compose");
      const bound = definition({
        status,
        summary: status,
        ...(status === "failed" ? { error: "verification failed", errorCode: "verification_failed" } : {})
      });

      await runJobWorker(cwd, job.id, workerDeps({ bindJobDefinition: () => bound }));

      expect(readJob(cwd, job.id)).toMatchObject({ status, pid: null, summary: status });
    }
  );

  it.each([
    ["bind", "definition bind failed"],
    ["buildPrompt", "prompt setup failed"],
    ["hook", "hook setup failed"],
    ["run", "spawn mimo ENOENT"],
    ["callback", "callback wait failed"],
    ["finalize", "verification execution failed"]
  ] as const)("turns a %s exception into one failed outcome", async (stage, message) => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "compose");
    const bound = definition();
    const overrides: Partial<JobWorkerDependencies> = { bindJobDefinition: () => bound };
    if (stage === "bind") overrides.bindJobDefinition = () => { throw new Error(message); };
    if (stage === "buildPrompt") vi.mocked(bound.buildPrompt).mockRejectedValueOnce(new Error(message));
    if (stage === "hook") overrides.createHookCallbackController = async () => { throw new Error(message); };
    if (stage === "run") overrides.runMimoStreaming = async () => { throw new Error(message); };
    if (stage === "callback") {
      const controller = hook();
      vi.mocked(controller.waitForCallback).mockRejectedValueOnce(new Error(message));
      overrides.createHookCallbackController = async () => controller;
    }
    if (stage === "finalize") vi.mocked(bound.finalize).mockRejectedValueOnce(new Error(message));

    await runJobWorker(cwd, job.id, workerDeps(overrides));

    const stored = readJob(cwd, job.id)!;
    expect(stored).toMatchObject({ status: "failed", pid: null });
    expect(stored.error).toContain(message);
    expect(readJobSignals(stored.signalsFile).signals.filter((signal) => signal.kind === "failed")).toHaveLength(1);
  });

  it("persists every raw line and normalized high-signal progress without failing on malformed lines", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement");
    const deps = workerDeps({
      runMimoStreaming: async (_cwd, _args, options) => {
        await options.onStart?.(456);
        await options.onLine?.('{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"input":{"command":"npm test"}}}}');
        await options.onLine?.("not-json-yet");
        await options.onLine?.('{"type":"text","text":"Done."}');
        return { ...completedRun, pid: 456 };
      }
    });

    await runJobWorker(cwd, job.id, deps);

    const stored = readJob(cwd, job.id)!;
    expect(fs.readFileSync(stored.eventsFile, "utf8")).toBe(
      '{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"input":{"command":"npm test"}}}}\n' +
      "not-json-yet\n" +
      '{"type":"text","text":"Done."}\n'
    );
    expect(fs.readFileSync(stored.logFile, "utf8")).toContain("npm test");
    expect(fs.readFileSync(stored.logFile, "utf8")).toContain("Done.");
    expect(readJobSignals(stored.signalsFile).signals.some((signal) => signal.kind === "milestone")).toBe(true);
  });

  it("clears PID and does not let a cancellation race create a second terminal event", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement", true);
    const deps = workerDeps({
      runMimoStreaming: async (_cwd, _args, options) => {
        await options.onStart?.(777);
        await transitionJob(cwd, job.id, { status: "cancelled", summary: "Cancelled by user." });
        return { ...completedRun, exitCode: 1, pid: 777, terminationReason: "host_abort" };
      }
    });

    await runJobWorker(cwd, job.id, deps);

    const stored = readJob(cwd, job.id)!;
    expect(stored).toMatchObject({ status: "cancelled", pid: null });
    const attention = readJobSignals(stored.signalsFile).signals.filter((signal) =>
      ["completed", "failed", "cancelled", "timeout"].includes(signal.kind)
    );
    expect(attention.map((signal) => signal.kind)).toEqual(["cancelled"]);
    expect(readDeliveries(stored.notificationOutboxFile)).toHaveLength(1);
  });

  it("starts notification delivery only for attention transitions and also for an existing unacknowledged delivery", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement", true);
    const spawn = vi.fn(() => 999);

    await runJobWorker(cwd, job.id, workerDeps({ spawnNotificationWorker: spawn }));
    expect(spawn).toHaveBeenCalledTimes(1);

    const restarted = workerDeps({ spawnNotificationWorker: spawn });
    await runJobWorker(cwd, job.id, restarted);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(restarted.runMimoStreaming).not.toHaveBeenCalled();
  });

  it("records notification spawn failure without changing the terminal outcome", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement", true);

    await runJobWorker(cwd, job.id, workerDeps({
      spawnNotificationWorker: () => { throw new Error("worker spawn failed"); }
    }));

    const stored = readJob(cwd, job.id)!;
    expect(stored.status).toBe("completed");
    expect(fs.readFileSync(stored.logFile, "utf8")).toContain("worker spawn failed");
    expect(readDeliveries(stored.notificationOutboxFile)[0]).toMatchObject({ status: "pending" });
  });

  it.each(["afterSignalAppended", "afterJobFinalized"] as const)(
    "recovers a terminal transition interrupted at %s without changing its outcome",
    async (faultPoint) => {
      const cwd = tempWorkspace();
      const job = seedJob(cwd, "implement", true);
      const spawn = vi.fn(() => 999);
      let failOnce = true;
      const interruptedTransition: typeof transitionJob = (transitionCwd, transitionJobId, request) =>
        transitionJob(transitionCwd, transitionJobId, request, {
          [faultPoint]: () => {
            if (request.status === "completed" && failOnce) {
              failOnce = false;
              throw new Error(`interrupted ${faultPoint}`);
            }
          }
        });

      await runJobWorker(cwd, job.id, workerDeps({
        transitionJob: interruptedTransition,
        spawnNotificationWorker: spawn
      }));

      const stored = readJob(cwd, job.id)!;
      expect(stored).toMatchObject({ status: "completed", pid: null });
      expect(readJobSignals(stored.signalsFile).signals.filter((signal) => signal.kind === "completed")).toHaveLength(1);
      expect(readDeliveries(stored.notificationOutboxFile)).toHaveLength(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    }
  );

  it("keeps callback final text transient through finalization", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement");
    const bound = definition({ summary: "done" });
    const callback = { ...completedCallback, finalText: "TRANSIENT_CALLBACK_ONLY" };

    await runJobWorker(cwd, job.id, workerDeps({
      bindJobDefinition: () => bound,
      createHookCallbackController: async () => hook(callback)
    }));

    expect(vi.mocked(bound.finalize).mock.calls[0][0]).toMatchObject({
      callbackFinalText: "TRANSIENT_CALLBACK_ONLY",
      executionCallback: {
        invocationId: "inv-worker",
        outcome: "completed"
      }
    });
    expect(vi.mocked(bound.finalize).mock.calls[0][0].executionCallback).not.toHaveProperty("finalText");
    expect(fs.readFileSync(path.join(cwd, ".codex-mimo", "jobs", `${job.id}.json`), "utf8"))
      .not.toContain("TRANSIENT_CALLBACK_ONLY");
  });

  it("does not let hook close failure replace a successful result", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement");
    const controller = hook();
    vi.mocked(controller.close).mockRejectedValueOnce(new Error("close failed"));

    await runJobWorker(cwd, job.id, workerDeps({
      createHookCallbackController: async () => controller
    }));

    const stored = readJob(cwd, job.id)!;
    expect(stored.status).toBe("completed");
    expect(fs.readFileSync(stored.logFile, "utf8")).toContain("close failed");
  });
});
