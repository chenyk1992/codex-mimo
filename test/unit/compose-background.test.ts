import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runComposeJobWorker } from "../../src/compose/job-worker.js";
import { createJobStore, readJob } from "../../src/core/job-store.js";

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-compose-worker-"));
}

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

  it("keeps partial report paths when MiMo exits nonzero", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      workflow: "dev",
      task: "Failing task",
      request: { cwd, workflow: "dev", task: "Failing task" }
    });

    await runComposeJobWorker(cwd, job.id, {
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
