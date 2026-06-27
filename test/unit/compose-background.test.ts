import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runComposeJobWorker } from "../../src/compose/job-worker.js";
import { createJobStore, readJob } from "../../src/core/job-store.js";

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-compose-worker-"));
}

const completedWorkerHook = {
  createHookCallbackController: async () => ({
    invocationId: "compose-test-1",
    token: "token",
    endpoint: "http://127.0.0.1:1/mimo-hook",
    configDir: "hook-dir",
    callbackFile: "callback.json",
    env: {},
    waitForCallback: async () => ({
      invocationId: "compose-test-1",
      event: "session.post" as const,
      outcome: "completed" as const,
      sessionId: "ses_callback",
      receivedAt: "2026-06-23T00:00:00.000Z"
    }),
    close: async () => undefined
  })
};

describe("compose job worker", () => {
  it("records the active MiMo pid as soon as the child process starts", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      workflow: "dev",
      task: "Long task",
      request: { cwd, workflow: "dev", task: "Long task" }
    });

    let finishRun!: () => void;
    const worker = runComposeJobWorker(cwd, job.id, {
      ...completedWorkerHook,
      runMimoStreaming: async (_cwd, _args, options) => {
        options.onStart?.(999);
        await new Promise<void>((resolve) => {
          finishRun = resolve;
        });
        return { stdout: "", stderr: "", exitCode: 0, pid: 999 };
      },
      captureDiff: async () => ({ changedFiles: [], diffStat: "", diff: "" }),
      captureStatus: async () => ({ short: "", dirty: false }),
      runVerification: async () => []
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(readJob(cwd, job.id)).toMatchObject({
      status: "running",
      pid: 999
    });

    finishRun();
    await worker;
  });

  it("runs a stored compose request and completes the job", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      workflow: "dev",
      task: "Implement login throttling",
      request: {
        cwd,
        workflow: "dev",
        task: "Implement login throttling",
        reportDir: path.join(cwd, ".codex-mimo", "reports")
      }
    });

    await runComposeJobWorker(cwd, job.id, {
      ...completedWorkerHook,
      runMimoStreaming: async (_cwd, _args, options) => {
        options.onLine?.("{\"type\":\"message\",\"text\":\"done\"}");
        return {
          stdout: "{\"type\":\"message\",\"text\":\"done\"}\n",
          stderr: "",
          exitCode: 0,
          pid: 777
        };
      },
      captureDiff: async () => ({ changedFiles: [], diffStat: "", diff: "" }),
      captureStatus: async () => ({ short: "", dirty: false }),
      runVerification: async () => [],
      now: () => new Date("2026-06-23T00:00:00.000Z")
    });

    const updated = readJob(cwd, job.id);
    expect(updated.status).toBe("completed");
    expect(updated.phase).toBe("done");
    expect(updated.summary).toContain("dev passed");
    expect(updated.reportPaths?.json).toContain(".json");
  });

  it("marks write workflows needs_review when only git status detects changed files", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      workflow: "dev",
      task: "Create untracked file",
      request: {
        cwd,
        workflow: "dev",
        task: "Create untracked file",
        reportDir: path.join(cwd, ".codex-mimo", "reports")
      }
    });
    let statusCalls = 0;

    await runComposeJobWorker(cwd, job.id, {
      ...completedWorkerHook,
      runMimoStreaming: async () => ({
        stdout: "{\"type\":\"message\",\"text\":\"created file\"}\n",
        stderr: "",
        exitCode: 0,
        pid: 777
      }),
      captureDiff: async () => ({ changedFiles: [], diffStat: "", diff: "" }),
      captureStatus: async () => {
        statusCalls += 1;
        return statusCalls === 1
          ? { short: "", dirty: false }
          : { short: "?? src/new-file.ts", dirty: true };
      },
      runVerification: async () => []
    });

    const updated = readJob(cwd, job.id);
    expect(updated.status).toBe("completed");
    expect(updated.summary).toContain("dev needs_review");
    expect(updated.changedFiles).toContain("src/new-file.ts");
    expect(JSON.parse(fs.readFileSync(updated.reportPaths!.json!, "utf-8")).status).toBe("needs_review");
  });

  it("passes hook env to streaming runner, waits for callback, and stores completed callback", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      workflow: "dev",
      task: "Implement login throttling",
      request: { cwd, workflow: "dev", task: "Implement login throttling" }
    });
    const waitForCallback = vi.fn(async () => ({
      invocationId: "compose-dev-1",
      event: "session.post" as const,
      outcome: "completed" as const,
      sessionId: "ses_callback",
      receivedAt: "2026-06-23T00:00:02.000Z"
    }));
    const close = vi.fn(async () => undefined);
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    await runComposeJobWorker(cwd, job.id, {
      createHookCallbackController: async () => ({
        invocationId: "compose-dev-1",
        token: "token",
        endpoint: "http://127.0.0.1:1/mimo-hook",
        configDir: path.join(cwd, ".codex-mimo", "runtime-hooks", "compose-dev-1"),
        callbackFile: path.join(cwd, ".codex-mimo", "callbacks", "compose-dev-1.json"),
        env: { CODEX_MIMO_INVOCATION_ID: "compose-dev-1" },
        waitForCallback,
        close
      }),
      runMimoStreaming: async (_cwd, _args, options) => {
        capturedEnv = options.env;
        return {
          stdout: "{\"type\":\"step_start\",\"sessionID\":\"ses_events\",\"part\":{\"type\":\"step-start\"}}\n",
          stderr: "",
          exitCode: 0,
          pid: 777
        };
      },
      captureDiff: async () => ({ changedFiles: [], diffStat: "", diff: "" }),
      captureStatus: async () => ({ short: "", dirty: false }),
      runVerification: async () => []
    });

    const updated = readJob(cwd, job.id);
    expect(capturedEnv).toMatchObject({ CODEX_MIMO_INVOCATION_ID: "compose-dev-1" });
    expect(waitForCallback).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(updated.callback).toMatchObject({ outcome: "completed", sessionId: "ses_callback" });
    expect(updated.sessionId).toBe("ses_callback");
  });

  it("fails the job when callback is missing even if MiMo exits successfully", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      workflow: "dev",
      task: "Implement login throttling",
      request: { cwd, workflow: "dev", task: "Implement login throttling" }
    });

    await runComposeJobWorker(cwd, job.id, {
      createHookCallbackController: async () => ({
        invocationId: "compose-dev-2",
        token: "token",
        endpoint: "http://127.0.0.1:1/mimo-hook",
        configDir: "hook-dir",
        callbackFile: "callback.json",
        env: {},
        waitForCallback: async () => null,
        close: async () => undefined
      }),
      runMimoStreaming: async () => ({ stdout: "{\"type\":\"message\",\"text\":\"done\"}\n", stderr: "", exitCode: 0, pid: 777 }),
      captureDiff: async () => ({ changedFiles: [], diffStat: "", diff: "" }),
      captureStatus: async () => ({ short: "", dirty: false }),
      runVerification: async () => []
    });

    const updated = readJob(cwd, job.id);
    expect(updated.status).toBe("failed");
    expect(updated.errorCode).toBe("callback_missing");
    expect(updated.callback).toMatchObject({ invocationId: "compose-dev-2", outcome: "missing" });
    expect(updated.error).toContain("MiMoCode exited before codex-mimo received session.post");
  });

  it("fails the job with callback error precedence when callback reports error and MiMo exits nonzero", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      workflow: "dev",
      task: "Implement login throttling",
      request: { cwd, workflow: "dev", task: "Implement login throttling" }
    });

    await runComposeJobWorker(cwd, job.id, {
      createHookCallbackController: async () => ({
        invocationId: "compose-dev-3",
        token: "token",
        endpoint: "http://127.0.0.1:1/mimo-hook",
        configDir: "hook-dir",
        callbackFile: "callback.json",
        env: {},
        waitForCallback: async () => ({
          invocationId: "compose-dev-3",
          event: "session.post",
          outcome: "error",
          sessionId: "ses_error",
          receivedAt: "2026-06-23T00:00:03.000Z",
          error: "MiMo hook reported failure"
        }),
        close: async () => undefined
      }),
      runMimoStreaming: async () => ({ stdout: "{\"type\":\"message\",\"text\":\"done\"}\n", stderr: "process failed", exitCode: 2, pid: 777 }),
      captureDiff: async () => ({ changedFiles: [], diffStat: "", diff: "" }),
      captureStatus: async () => ({ short: "", dirty: false }),
      runVerification: async () => []
    });

    const updated = readJob(cwd, job.id);
    expect(updated.status).toBe("failed");
    expect(updated.errorCode).toBe("callback_error");
    expect(updated.callback).toMatchObject({ outcome: "error", sessionId: "ses_error" });
    expect(updated.error).toContain("MiMo hook reported failure");
  });

  it("fails read-only workflows when background compose modifies files", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      workflow: "plan",
      task: "Write a plan only",
      request: { cwd, workflow: "plan", task: "Write a plan only" }
    });

    let statusCalls = 0;
    await runComposeJobWorker(cwd, job.id, {
      ...completedWorkerHook,
      runMimoStreaming: async () => ({ stdout: "{\"type\":\"message\",\"text\":\"changed a file\"}\n", stderr: "", exitCode: 0, pid: 777 }),
      captureDiff: async () => ({ changedFiles: ["README.md"], diffStat: " README.md | 1 +", diff: "" }),
      captureStatus: async () => {
        statusCalls += 1;
        return statusCalls === 1
          ? { short: "", dirty: false }
          : { short: " M README.md", dirty: true };
      },
      runVerification: async () => []
    });

    const updated = readJob(cwd, job.id);
    expect(updated.status).toBe("failed");
    expect(updated.errorCode).toBe("read_only_violation");
    expect(updated.error).toContain("Read-only workflow plan modified files: README.md");
  });

  it("fails background compose on semantic clarification output", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      workflow: "plan",
      task: "Write a validation plan",
      request: { cwd, workflow: "plan", task: "Write a validation plan" }
    });

    await runComposeJobWorker(cwd, job.id, {
      ...completedWorkerHook,
      runMimoStreaming: async () => ({
        stdout: "{\"type\":\"message\",\"text\":\"What would you like me to help with?\"}\n",
        stderr: "",
        exitCode: 0,
        pid: 777
      }),
      captureDiff: async () => ({ changedFiles: [], diffStat: "", diff: "" }),
      captureStatus: async () => ({ short: "", dirty: false }),
      runVerification: async () => []
    });

    const updated = readJob(cwd, job.id);
    expect(updated.status).toBe("failed");
    expect(updated.errorCode).toBe("semantic_failure");
    expect(updated.error).toContain("MiMoCode did not receive or accept the task objective");
  });

  it("uses verification_failed errorCode when verification command execution throws", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      workflow: "dev",
      task: "Implement login throttling",
      request: { cwd, workflow: "dev", task: "Implement login throttling", verification: ["npm test"] }
    });

    await runComposeJobWorker(cwd, job.id, {
      ...completedWorkerHook,
      runMimoStreaming: async () => ({ stdout: "{\"type\":\"message\",\"text\":\"done\"}\n", stderr: "", exitCode: 0, pid: 777 }),
      captureDiff: async () => ({ changedFiles: [], diffStat: "", diff: "" }),
      captureStatus: async () => ({ short: "", dirty: false }),
      runVerification: async () => {
        throw new Error("verification runner crashed");
      }
    });

    const updated = readJob(cwd, job.id);
    expect(updated.status).toBe("failed");
    expect(updated.errorCode).toBe("verification_failed");
    expect(updated.error).toContain("verification runner crashed");
  });

  it("keeps partial report paths when MiMo exits nonzero", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      workflow: "dev",
      task: "Failing task",
      request: { cwd, workflow: "dev", task: "Failing task" }
    });

    await runComposeJobWorker(cwd, job.id, {
      ...completedWorkerHook,
      runMimoStreaming: async (_cwd, _args, options) => {
        options.onLine?.("{\"type\":\"message\",\"text\":\"partial\"}");
        return { stdout: "{\"type\":\"message\",\"text\":\"partial\"}\n", stderr: "boom", exitCode: 2, pid: 111 };
      },
      captureDiff: async () => ({ changedFiles: [], diffStat: "", diff: "" }),
      captureStatus: async () => ({ short: "", dirty: false }),
      runVerification: async () => [],
      now: () => new Date("2026-06-23T00:00:00.000Z")
    });

    const updated = readJob(cwd, job.id);
    expect(updated.status).toBe("failed");
    expect(updated.reportPaths?.json).toContain(".json");
    expect(fs.existsSync(updated.reportPaths!.json!)).toBe(true);
  });

  it("fails background compose jobs when MiMoCode times out", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      workflow: "dev",
      task: "Long running task",
      request: { cwd, workflow: "dev", task: "Long running task" }
    });

    await runComposeJobWorker(cwd, job.id, {
      ...completedWorkerHook,
      createHookCallbackController: async () => ({
        invocationId: "compose-timeout",
        token: "token",
        endpoint: "http://127.0.0.1:1/mimo-hook",
        configDir: "hook-dir",
        callbackFile: "callback.json",
        env: {},
        waitForCallback: async () => null,
        close: async () => undefined
      }),
      runMimoStreaming: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 124,
        pid: 111,
        terminationReason: "process_timeout"
      }),
      captureDiff: async () => ({ changedFiles: [], diffStat: "", diff: "" }),
      captureStatus: async () => ({ short: "", dirty: false }),
      runVerification: async () => []
    });

    const updated = readJob(cwd, job.id);
    expect(updated.status).toBe("failed");
    expect(updated.errorCode).toBe("timeout");
    expect(updated.error).toContain("configured process timeout");
    expect(updated.callback).toMatchObject({ outcome: "missing" });
    expect(JSON.parse(fs.readFileSync(updated.reportPaths!.json!, "utf-8")).status).toBe("timeout");
  });

  it("uses prompt transport for Chinese prompts", async () => {
    const cwd = tempWorkspace();
    const chineseTask = "实现登录节流功能，确保安全性";
    const job = createJobStore(cwd).create({
      kind: "compose",
      workflow: "dev",
      task: chineseTask,
      request: { cwd, workflow: "dev", task: chineseTask }
    });

    let capturedArgs: string[] = [];
    await runComposeJobWorker(cwd, job.id, {
      ...completedWorkerHook,
      runMimoStreaming: async (_cwd, args, _options) => {
        capturedArgs = args;
        return { stdout: "{\"type\":\"message\",\"text\":\"done\"}\n", stderr: "", exitCode: 0, pid: 555 };
      },
      captureDiff: async () => ({ changedFiles: [], diffStat: "", diff: "" }),
      captureStatus: async () => ({ short: "", dirty: false }),
      runVerification: async () => [],
      now: () => new Date("2026-06-23T00:00:00.000Z")
    });

    expect(capturedArgs.some((a) => a.includes("Objective is stored in UTF-8 prompt file"))).toBe(true);
    expect(capturedArgs.some((a) => a.includes("prompt.md"))).toBe(true);
  });
});
