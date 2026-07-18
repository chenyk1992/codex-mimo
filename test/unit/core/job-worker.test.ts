import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoundJobDefinition } from "../../../src/core/job-definitions.js";
import { runJobWorker, type JobWorkerDependencies } from "../../../src/core/job-worker.js";
import { readJob, createJobStore, resolveJobStateFile } from "../../../src/core/job-store.js";
import {
  requestJobCancellation,
  transitionJob,
  updateRunningJobProcess
} from "../../../src/core/job-transition.js";
import type { JobKind, JobRecord } from "../../../src/core/jobs.js";
import { readJobSignals } from "../../../src/core/job-signals.js";
import { withUtf8ProcessEnv } from "../../../src/core/encoding.js";
import { readDeliveries } from "../../../src/notify/outbox.js";
import type { HookCallbackController, MimoHookCallbackSummary } from "../../../src/mimo/hook-callback.js";
import {
  runMimoCliStreaming,
  type StreamingRunOptions,
  type StreamingRunResult
} from "../../../src/mimo/streaming-runner.js";

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
  vi.unstubAllEnvs();
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
    executionPolicy: { agent: "build", writesAllowed: true },
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
    captureProcessIdentity: vi.fn(() => ({
      status: "running" as const,
      identity: "start-321",
      evidence: "test process"
    })),
    spawnNotificationWorker: vi.fn(() => 999),
    ...overrides
  };
}

describe("runJobWorker", () => {
  it.each(["CODEX_MIMO_COMMAND", "MIMO_COMMAND"])(
    "does not select a current work job's protected %s value as the MiMo executable",
    async (secretEnv) => {
      const cwd = tempWorkspace();
      const secretValue = `${secretEnv.toLowerCase()}-secret`;
      const job = createJobStore(cwd).create({
        kind: "implement",
        task: "Run the protected job",
        request: { cwd },
        notificationTarget: {
          type: "webhook",
          url: "https://example.test/current",
          secretEnv
        }
      });
      vi.stubEnv(secretEnv, secretValue);
      let selection: { command: string; shell: boolean | string } | undefined;
      const deps = workerDeps({
        runMimoStreaming: (runCwd, args, options) => runMimoCliStreaming(runCwd, args, {
          ...options,
          spawnProcess: (_spawnCwd, _spawnArgs, env, selected) => {
            selection = selected;
            expect(JSON.stringify(env)).not.toContain(secretValue);
            const child = new EventEmitter() as EventEmitter & {
              stdout: Readable;
              stderr: Readable;
              pid: number;
              kill: () => boolean;
            };
            child.pid = 321;
            child.stdout = Readable.from([""]);
            child.stderr = Readable.from([""]);
            child.kill = () => true;
            queueMicrotask(() => child.emit("error", new Error(
              `spawn ${selected?.command ?? "missing-command"} ENOENT`
            )));
            return child;
          }
        })
      });

      await runJobWorker(cwd, job.id, deps);

      expect(selection?.command).toBe("mimo");
      expect(readJob(cwd, job.id)).toMatchObject({
        status: "failed",
        error: expect.stringContaining("spawn mimo ENOENT")
      });
      expect(JSON.stringify(readJob(cwd, job.id))).not.toContain(secretValue);
    }
  );

  it("omits every persisted webhook secret before launching MiMoCode", async () => {
    const cwd = tempWorkspace();
    const current = createJobStore(cwd).create({
      kind: "implement",
      task: "Run the current job",
      request: { cwd },
      notificationTarget: {
        type: "webhook",
        url: "https://example.test/current",
        secretEnv: "CURRENT_WEBHOOK_SECRET"
      }
    });
    createJobStore(cwd).create({
      kind: "plan",
      task: "Retain a different job's secret",
      request: { cwd },
      notificationTarget: {
        type: "webhook",
        url: "https://example.test/other",
        secretEnv: "OTHER_WEBHOOK_SECRET"
      }
    });
    const deps = workerDeps();

    await runJobWorker(cwd, current.id, deps);

    const options = vi.mocked(deps.runMimoStreaming).mock.calls[0]?.[2];
    expect(options?.omitEnv).toEqual(expect.arrayContaining([
      "CURRENT_WEBHOOK_SECRET",
      "OTHER_WEBHOOK_SECRET"
    ]));
    expect(options?.omitEnv).toHaveLength(2);

    const childEnvironment = withUtf8ProcessEnv({
      current_webhook_secret: "current-secret",
      OTHER_WEBHOOK_SECRET: "other-secret"
    }, {
      base: {},
      omit: options?.omitEnv,
      platform: "win32"
    });
    expect(childEnvironment.current_webhook_secret).toBeUndefined();
    expect(childEnvironment.OTHER_WEBHOOK_SECRET).toBeUndefined();
  });

  it("passes its execution signal through prompt construction and every git capture", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement");
    const bound = definition();
    const deps = workerDeps({ bindJobDefinition: () => bound });

    await runJobWorker(cwd, job.id, deps);

    const signal = vi.mocked(bound.buildPrompt).mock.calls[0]?.[0];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(deps.captureStatus).toHaveBeenNthCalledWith(1, cwd, { signal });
    expect(deps.captureStatus).toHaveBeenNthCalledWith(2, cwd, { signal });
    expect(deps.captureHead).toHaveBeenNthCalledWith(1, cwd, { signal });
    expect(deps.captureHead).toHaveBeenNthCalledWith(2, cwd, { signal });
    expect(deps.captureDiff).toHaveBeenCalledWith(cwd, "HEAD", { signal });
    expect(deps.captureCommitChanges).toHaveBeenCalledWith(
      cwd,
      { oid: "abc", short: "abc", subject: "base" },
      { oid: "abc", short: "abc", subject: "base" },
      { signal }
    );
  });

  it("allows only one concurrent worker to own a queued job", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement", true);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const firstTransition = new Promise<void>((resolve) => { entered = resolve; });
    let runningCalls = 0;
    const delayedTransition: typeof transitionJob = async (transitionCwd, transitionJobId, request) => {
      if (request.status === "running") {
        runningCalls += 1;
        if (runningCalls === 1) {
          entered();
          await held;
        }
      }
      return transitionJob(transitionCwd, transitionJobId, request);
    };
    const deps = workerDeps({ transitionJob: delayedTransition });

    const first = runJobWorker(cwd, job.id, deps);
    await firstTransition;
    const second = runJobWorker(cwd, job.id, deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await Promise.all([first, second]);

    const stored = readJob(cwd, job.id)!;
    const signals = readJobSignals(stored.signalsFile).signals;
    expect(deps.bindJobDefinition).toHaveBeenCalledTimes(1);
    expect(deps.runMimoStreaming).toHaveBeenCalledTimes(1);
    expect(signals.filter((signal) =>
      signal.kind === "phase_changed" && signal.phase === "starting"
    )).toHaveLength(1);
    expect(signals.filter((signal) => signal.kind === "completed")).toHaveLength(1);
    expect(readDeliveries(stored.notificationOutboxFile)).toHaveLength(1);
  });

  it.each([null, 808])("recovers a stale running job with stored PID %s without rerunning MiMo", async (pid) => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement", true);
    await transitionJob(cwd, job.id, {
      status: "running",
      phase: "starting",
      summary: "started",
      pid,
      processIdentity: pid === null ? null : `start-${pid}`
    });
    const terminateOwnedProcess = vi.fn(() => ({
      status: "terminated" as const,
      evidence: "confirmed gone"
    }));
    const deps = {
      ...workerDeps(),
      terminateOwnedProcess
    } as JobWorkerDependencies;

    await runJobWorker(cwd, job.id, deps);
    await runJobWorker(cwd, job.id, deps);

    const stored = readJob(cwd, job.id)!;
    expect(stored).toMatchObject({
      status: "failed",
      errorCode: "worker_restarted",
      pid: null
    });
    if (pid === null) {
      expect(terminateOwnedProcess).not.toHaveBeenCalled();
    } else {
      expect(terminateOwnedProcess).toHaveBeenCalledTimes(1);
      expect(terminateOwnedProcess).toHaveBeenCalledWith(pid, `start-${pid}`);
    }
    expect(deps.runMimoStreaming).not.toHaveBeenCalled();
    expect(readJobSignals(stored.signalsFile).signals.filter((signal) => signal.kind === "failed")).toHaveLength(1);
    expect(readDeliveries(stored.notificationOutboxFile)).toHaveLength(1);
    expect(deps.spawnNotificationWorker).toHaveBeenCalledTimes(2);
  });

  it("keeps stale recovery running when process termination cannot be confirmed", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement", true);
    await transitionJob(cwd, job.id, {
      status: "running",
      phase: "starting",
      summary: "started",
      pid: 808,
      processIdentity: "start-808"
    });
    const deps = workerDeps({
      terminateOwnedProcess: vi.fn(() => ({
        status: "unconfirmed",
        evidence: "access denied"
      }))
    });

    await runJobWorker(cwd, job.id, deps);

    expect(readJob(cwd, job.id)).toMatchObject({
      status: "running",
      pid: 808,
      processIdentity: "start-808"
    });
    expect(readJobSignals(job.signalsFile).signals.filter((signal) => signal.kind === "blocked"))
      .toHaveLength(0);
    expect(readDeliveries(job.notificationOutboxFile)).toHaveLength(0);
    expect(deps.runMimoStreaming).not.toHaveBeenCalled();
  });

  it("keeps a timed-out run owned until failed termination can be confirmed", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "implement",
      task: "Implement it",
      request: { cwd, task: "Implement it", allowWrite: true, timeoutMs: 1 }
    });
    const terminationFailure = new Error("Windows process termination could not be confirmed");
    const deps = workerDeps({
      runMimoStreaming: async (_cwd, _args, options) => {
        await options.onStart?.(911);
        throw terminationFailure;
      },
      terminateOwnedProcess: vi.fn(() => ({
        status: "unconfirmed",
        evidence: "PID 911 remains alive"
      }))
    });

    await runJobWorker(cwd, job.id, deps);

    expect(readJob(cwd, job.id)).toMatchObject({
      status: "running",
      pid: 911,
      processIdentity: "start-321"
    });
    expect(readJobSignals(job.signalsFile).signals.filter((signal) =>
      ["failed", "timeout", "blocked"].includes(signal.kind)
    )).toHaveLength(0);
  });

  it.each([null, 808])(
    "finalizes a restarted pending cancellation after confirming stored process %s inactive",
    async (pid) => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement", true);
    await transitionJob(cwd, job.id, {
      status: "running",
      phase: "starting",
      summary: "started",
      pid,
      processIdentity: pid === null ? null : "start-808"
    });
    await requestJobCancellation(cwd, job.id);
    const deps = workerDeps({
      terminateOwnedProcess: vi.fn(() => ({ status: "terminated", evidence: "tree gone" }))
    });

    await runJobWorker(cwd, job.id, deps);

    expect(readJob(cwd, job.id)).toMatchObject({ status: "cancelled", pid: null });
    expect(readJobSignals(job.signalsFile).signals.at(-1)?.kind).toBe("cancelled");
    expect(readDeliveries(job.notificationOutboxFile)).toHaveLength(1);
    if (pid === null) expect(deps.terminateOwnedProcess).not.toHaveBeenCalled();
  });

  it("keeps restarted cancellation pending when owned termination is unconfirmed", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement", true);
    await transitionJob(cwd, job.id, {
      status: "running",
      phase: "starting",
      summary: "started",
      pid: 808,
      processIdentity: "start-808"
    });
    await requestJobCancellation(cwd, job.id);
    const deps = workerDeps({
      terminateOwnedProcess: vi.fn(() => ({ status: "unconfirmed", evidence: "tree live" }))
    });

    await runJobWorker(cwd, job.id, deps);

    expect(readJob(cwd, job.id)).toMatchObject({
      status: "running",
      pid: 808,
      processIdentity: "start-808",
      cancellationRequestedAt: expect.any(String)
    });
    expect(readJobSignals(job.signalsFile).signals.filter((signal) => signal.kind === "cancelled"))
      .toHaveLength(0);
    expect(readDeliveries(job.notificationOutboxFile)).toHaveLength(0);
  });

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

  it("stops after buildPrompt when the job is cancelled during prompt setup", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "plan");
    const bound = definition();
    vi.mocked(bound.buildPrompt).mockImplementationOnce(async () => {
      await transitionJob(cwd, job.id, { status: "cancelled", summary: "cancelled" });
      return { message: "prompt", files: [] };
    });
    const deps = workerDeps({ bindJobDefinition: () => bound });

    await runJobWorker(cwd, job.id, deps);

    expect(readJob(cwd, job.id)?.status).toBe("cancelled");
    expect(deps.createHookCallbackController).not.toHaveBeenCalled();
    expect(deps.runMimoStreaming).not.toHaveBeenCalled();
  });

  it("stops and closes the hook when cancelled after hook creation", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement");
    const controller = hook();
    const deps = workerDeps({
      createHookCallbackController: async () => {
        await transitionJob(cwd, job.id, { status: "cancelled", summary: "cancelled" });
        return controller;
      }
    });

    await runJobWorker(cwd, job.id, deps);

    expect(readJob(cwd, job.id)?.status).toBe("cancelled");
    expect(deps.runMimoStreaming).not.toHaveBeenCalled();
    expect(controller.close).toHaveBeenCalledTimes(1);
  });

  it("aborts a newly spawned child when cancellation wins the PID-null window", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement");
    let observedAborted = false;
    const deps = workerDeps({
      runMimoStreaming: async (_cwd, _args, options) => {
        await transitionJob(cwd, job.id, { status: "cancelled", summary: "cancelled" });
        await options.onStart?.(909);
        observedAborted = options.signal?.aborted ?? false;
        return { ...completedRun, exitCode: 124, pid: 909, terminationReason: "host_abort" };
      }
    });

    await runJobWorker(cwd, job.id, deps);

    expect(observedAborted).toBe(true);
    expect(readJob(cwd, job.id)).toMatchObject({ status: "cancelled", pid: null });
  });

  it("continuously aborts a hanging MiMo run when the authoritative job is cancelled", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement");
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let observedSignal: AbortSignal | undefined;
    const bound = definition();
    const deps = workerDeps({
      bindJobDefinition: () => bound,
      statusPollMs: 5,
      runMimoStreaming: async (_cwd, _args, options) => {
        observedSignal = options.signal;
        await options.onStart?.(909);
        started();
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { ...completedRun, exitCode: 124, pid: 909, terminationReason: "host_abort" };
      }
    });

    const worker = runJobWorker(cwd, job.id, deps);
    await running;
    await transitionJob(cwd, job.id, { status: "cancelled", summary: "cancelled" });
    await worker;

    expect(observedSignal?.aborted).toBe(true);
    expect(bound.finalize).not.toHaveBeenCalled();
    expect(deps.captureDiff).not.toHaveBeenCalled();
    expect(readJob(cwd, job.id)).toMatchObject({
      status: "cancelled",
      pid: null,
      processIdentity: null
    });
  });

  it("awaits production process termination before finalizing a cancellation intent", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement", true);
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let releaseTermination!: () => void;
    const termination = new Promise<void>((resolve) => { releaseTermination = resolve; });
    let workerSettled = false;
    let observedSignal: AbortSignal | undefined;
    const bound = definition();
    const deps = workerDeps({
      bindJobDefinition: () => bound,
      statusPollMs: 5,
      runMimoStreaming: async (_cwd, _args, options) => {
        observedSignal = options.signal;
        await options.onStart?.(909);
        started();
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await termination;
        return { ...completedRun, exitCode: 124, pid: 909, terminationReason: "host_abort" };
      }
    });

    const worker = runJobWorker(cwd, job.id, deps).finally(() => { workerSettled = true; });
    await running;
    await requestJobCancellation(cwd, job.id);
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    expect(workerSettled).toBe(false);
    expect(readJob(cwd, job.id)).toMatchObject({
      status: "running",
      pid: 909,
      cancellationRequestedAt: expect.any(String)
    });

    releaseTermination();
    await worker;

    expect(bound.finalize).not.toHaveBeenCalled();
    const stored = readJob(cwd, job.id);
    expect(stored).toMatchObject({ status: "cancelled", pid: null, processIdentity: null });
    expect(stored).not.toHaveProperty("cancellationRequestedAt");
    expect(readJobSignals(job.signalsFile).signals.at(-1)?.kind).toBe("cancelled");
  });

  it("leaves cancellation pending when production termination is unconfirmed", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement", true);
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const failure = new Error("taskkill failed; tree still live");
    const deps = workerDeps({
      statusPollMs: 5,
      terminateOwnedProcess: vi.fn(() => ({
        status: "unconfirmed" as const,
        evidence: "tree remains live"
      })),
      runMimoStreaming: async (_cwd, _args, options) => {
        await options.onStart?.(910);
        started();
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw failure;
      }
    });

    const worker = runJobWorker(cwd, job.id, deps);
    await running;
    await requestJobCancellation(cwd, job.id);
    await worker;

    expect(readJob(cwd, job.id)).toMatchObject({
      status: "running",
      pid: 910,
      cancellationRequestedAt: expect.any(String)
    });
    expect(readJobSignals(job.signalsFile).signals.filter((signal) => signal.kind === "cancelled"))
      .toHaveLength(0);
    expect(readDeliveries(job.notificationOutboxFile)).toHaveLength(0);
  });

  it("checks cancellation between every final Git capture", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement");
    const bound = definition();
    let statusCalls = 0;
    const captureStatus = vi.fn(async () => {
      statusCalls += 1;
      if (statusCalls === 2) {
        await transitionJob(cwd, job.id, { status: "cancelled", summary: "cancelled" });
      }
      return { short: "", dirty: false, fingerprints: {} };
    });
    const captureHead = vi.fn(async () => ({ oid: "abc", short: "abc", subject: "base" }));
    const deps = workerDeps({ bindJobDefinition: () => bound, captureStatus, captureHead });

    await runJobWorker(cwd, job.id, deps);

    expect(captureStatus).toHaveBeenCalledTimes(2);
    expect(captureHead).toHaveBeenCalledTimes(1);
    expect(deps.captureDiff).not.toHaveBeenCalled();
    expect(deps.captureCommitChanges).not.toHaveBeenCalled();
    expect(bound.finalize).not.toHaveBeenCalled();
  });

  it("aborts a hanging finalizer verification and never reaches its later writer", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "compose");
    let verificationStarted!: () => void;
    const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
    const laterWriter = vi.fn();
    const bound = definition();
    vi.mocked(bound.finalize).mockImplementationOnce(async (context) => {
      verificationStarted();
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
      laterWriter();
      return { status: "completed", summary: "done" };
    });
    const deps = workerDeps({ bindJobDefinition: () => bound, statusPollMs: 5 });

    const worker = runJobWorker(cwd, job.id, deps);
    await started;
    await transitionJob(cwd, job.id, { status: "cancelled", summary: "cancelled" });
    await worker;

    expect(laterWriter).not.toHaveBeenCalled();
    expect(readJob(cwd, job.id)?.status).toBe("cancelled");
  });

  it("stops a pending callback wait when the authoritative job becomes cancelled", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement");
    const controller = hook();
    let callbackStarted!: () => void;
    const started = new Promise<void>((resolve) => { callbackStarted = resolve; });
    vi.mocked(controller.waitForCallback).mockImplementationOnce(() => {
      callbackStarted();
      return new Promise(() => {});
    });
    const bound = definition();
    const deps = workerDeps({
      bindJobDefinition: () => bound,
      createHookCallbackController: async () => controller,
      statusPollMs: 5
    });

    const worker = runJobWorker(cwd, job.id, deps);
    await started;
    await transitionJob(cwd, job.id, { status: "cancelled", summary: "cancelled" });
    const settled = await Promise.race([
      worker.then(() => "done"),
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 100))
    ]);

    expect(settled).toBe("done");
    expect(bound.finalize).not.toHaveBeenCalled();
    expect(deps.captureDiff).not.toHaveBeenCalled();
    expect(controller.close).toHaveBeenCalledTimes(1);
  });

  it("detaches the callback abort listener when cancellation wins", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement");
    const controller = hook();
    let callbackStarted!: () => void;
    const started = new Promise<void>((resolve) => { callbackStarted = resolve; });
    vi.mocked(controller.waitForCallback).mockImplementationOnce(() => {
      callbackStarted();
      return new Promise(() => {});
    });
    const removeListener = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    const deps = workerDeps({
      createHookCallbackController: async () => controller,
      statusPollMs: 5
    });

    const worker = runJobWorker(cwd, job.id, deps);
    await started;
    await transitionJob(cwd, job.id, { status: "cancelled", summary: "cancelled" });
    await worker;

    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it.each([
    "prompt",
    "hook",
    "event-write",
    "hook-close",
    "git-status",
    "git-head",
    "git-diff",
    "git-commit",
    "finalizer"
  ] as const)("abandons a never-resolving %s dependency after external cancellation", async (stage) => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement");
    const bound = definition();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<never>(() => {});
    const overrides: Partial<JobWorkerDependencies> = {
      bindJobDefinition: () => bound,
      statusPollMs: 5
    };

    if (stage === "prompt") vi.mocked(bound.buildPrompt).mockImplementationOnce(() => {
      entered();
      return pending;
    });
    if (stage === "hook") overrides.createHookCallbackController = () => {
      entered();
      return pending;
    };
    if (stage === "event-write") overrides.appendRawAndNormalizedEvent = () => {
      entered();
      return pending;
    };
    if (stage === "hook-close") {
      const closingHook = hook();
      vi.mocked(closingHook.close).mockImplementationOnce(() => {
        entered();
        return pending;
      });
      overrides.createHookCallbackController = async () => closingHook;
    }
    if (stage === "git-status") overrides.captureStatus = () => {
      entered();
      return pending;
    };
    if (stage === "git-head") overrides.captureHead = () => {
      entered();
      return pending;
    };
    if (stage === "git-diff") overrides.captureDiff = () => {
      entered();
      return pending;
    };
    if (stage === "git-commit") overrides.captureCommitChanges = () => {
      entered();
      return pending;
    };
    if (stage === "finalizer") vi.mocked(bound.finalize).mockImplementationOnce(() => {
      entered();
      return pending;
    });
    const deps = workerDeps(overrides);

    const worker = runJobWorker(cwd, job.id, deps);
    await started;
    await transitionJob(cwd, job.id, { status: "cancelled", summary: "cancelled" });
    const settled = await Promise.race([
      worker.then(() => "done" as const),
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 150))
    ]);

    expect(settled).toBe("done");
    expect(readJob(cwd, job.id)?.status).toBe("cancelled");
    if (stage === "prompt" || stage === "git-head") {
      expect(deps.createHookCallbackController).not.toHaveBeenCalled();
    }
    if (stage === "hook") expect(deps.runMimoStreaming).not.toHaveBeenCalled();
    if (stage === "event-write") expect(bound.finalize).not.toHaveBeenCalled();
    if (stage === "hook-close") expect(bound.finalize).not.toHaveBeenCalled();
    if (stage === "git-status") expect(deps.captureHead).not.toHaveBeenCalled();
    if (stage === "git-diff") expect(deps.captureCommitChanges).not.toHaveBeenCalled();
    if (stage === "git-commit") expect(bound.finalize).not.toHaveBeenCalled();
  });

  it("closes a hook controller that resolves after cancellation already released the worker", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement");
    const lateController = hook();
    let resolveHook!: (controller: HookCallbackController) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const hookCreation = new Promise<HookCallbackController>((resolve) => { resolveHook = resolve; });
    const deps = workerDeps({
      statusPollMs: 5,
      createHookCallbackController: () => {
        entered();
        return hookCreation;
      }
    });

    const worker = runJobWorker(cwd, job.id, deps);
    await started;
    await transitionJob(cwd, job.id, { status: "cancelled", summary: "cancelled" });
    await worker;
    resolveHook(lateController);

    await vi.waitFor(() => expect(lateController.close).toHaveBeenCalledOnce());
    expect(deps.runMimoStreaming).not.toHaveBeenCalled();
  });

  it("absorbs a dependency rejection that arrives after cancellation released ownership", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement");
    const bound = definition();
    let rejectPrompt!: (error: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(bound.buildPrompt).mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectPrompt = reject;
      entered();
    }));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      const worker = runJobWorker(cwd, job.id, workerDeps({
        bindJobDefinition: () => bound,
        statusPollMs: 5
      }));
      await started;
      await transitionJob(cwd, job.id, { status: "cancelled", summary: "cancelled" });
      await worker;
      rejectPrompt(new Error("late prompt failure"));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("stops the execution guard before committing its own terminal transition", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement");
    const bound = definition();
    let finalizeSignal!: AbortSignal;
    vi.mocked(bound.finalize).mockImplementationOnce(async (context) => {
      finalizeSignal = context.signal;
      return { status: "completed", summary: "done" };
    });
    const guardedTransition: typeof transitionJob = async (transitionCwd, transitionJobId, request) => {
      const result = await transitionJob(transitionCwd, transitionJobId, request);
      if (request.status === "completed") {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return result;
    };

    await runJobWorker(cwd, job.id, workerDeps({
      bindJobDefinition: () => bound,
      transitionJob: guardedTransition,
      statusPollMs: 5
    }));

    expect(readJob(cwd, job.id)?.status).toBe("completed");
    expect(finalizeSignal.aborted).toBe(false);
  });

  it("completes when auxiliary state.json refresh fails after authoritative job writes", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement");
    const stateFile = resolveJobStateFile(cwd);
    fs.rmSync(stateFile, { force: true });
    fs.mkdirSync(stateFile);

    await runJobWorker(cwd, job.id, workerDeps());

    expect(readJob(cwd, job.id)).toMatchObject({ status: "completed", pid: null });
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

  it("logs canonical file_path for read, write, and edit events", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement");
    const deps = workerDeps({
      runMimoStreaming: async (_cwd, _args, options) => {
        for (const tool of ["read", "write", "edit"]) {
          await options.onLine?.(JSON.stringify({
            type: "tool_use",
            part: {
              type: "tool",
              tool,
              state: { input: { file_path: `src/${tool}.ts`, filePath: "wrong.ts" } }
            }
          }));
        }
        return completedRun;
      }
    });

    await runJobWorker(cwd, job.id, deps);

    const log = fs.readFileSync(readJob(cwd, job.id)!.logFile, "utf8");
    expect(log).toContain("src/read.ts");
    expect(log).toContain("src/write.ts");
    expect(log).toContain("src/edit.ts");
    expect(log).not.toContain("wrong.ts");
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

  it("does not put callback final text into finalization context", async () => {
    const cwd = tempWorkspace();
    const job = seedJob(cwd, "implement");
    const bound = definition({ summary: "done" });
    const callback = { ...completedCallback, finalText: "TRANSIENT_CALLBACK_ONLY" };

    await runJobWorker(cwd, job.id, workerDeps({
      bindJobDefinition: () => bound,
      createHookCallbackController: async () => hook(callback)
    }));

    const finalizeContext = vi.mocked(bound.finalize).mock.calls[0][0];
    expect(finalizeContext).toMatchObject({
      executionCallback: {
        invocationId: "inv-worker",
        outcome: "completed"
      }
    });
    expect(finalizeContext).not.toHaveProperty("callbackFinalText");
    expect(finalizeContext.executionCallback).not.toHaveProperty("finalText");
    expect(JSON.stringify(finalizeContext)).not.toContain("TRANSIENT_CALLBACK_ONLY");
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
