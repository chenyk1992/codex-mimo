import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { terminateProcessTree } from "../../../src/mimo/streaming-runner.js";
import { createJobStore, readJob } from "../../../src/core/job-store.js";
import { transitionJob, updateRunningJobPid } from "../../../src/core/job-transition.js";

function makeChild(pid: number, killFn?: () => boolean) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    pid: number;
    kill: () => boolean;
  };
  child.pid = pid;
  child.stdout = Readable.from([""]);
  child.stderr = Readable.from([""]);
  child.kill = killFn ?? (() => true);
  return child;
}

describe("process management - terminateProcessTree", () => {
  it("Windows: uses taskkill /PID /T /F", () => {
    const child = makeChild(400);
    const spawnSync = vi.fn();

    terminateProcessTree(400, child, {
      platform: "win32",
      spawnSync,
      isProcessAlive: () => false
    });

    expect(spawnSync).toHaveBeenCalledWith("taskkill", ["/PID", "400", "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
  });

  it("Unix: SIGTERM group then SIGKILL fallback when process survives", () => {
    const child = makeChild(500, () => true);
    const killProcess = vi.fn();
    let aliveCalls = 0;
    const isProcessAlive = vi.fn().mockImplementation(() => {
      aliveCalls++;
      return aliveCalls <= 2;
    });

    terminateProcessTree(500, child, {
      platform: "linux",
      killProcess,
      isProcessAlive
    });

    expect(killProcess).toHaveBeenNthCalledWith(1, -500, "SIGTERM");
    expect(killProcess).toHaveBeenNthCalledWith(2, 500, "SIGTERM");
    expect(killProcess).toHaveBeenNthCalledWith(3, 500, "SIGKILL");
  });

  it("already-exited process does not throw", () => {
    const child = makeChild(600, () => true);
    const killProcess = vi.fn().mockImplementation(() => {
      throw new Error("ESRCH: no such process");
    });
    const isProcessAlive = vi.fn().mockReturnValue(false);

    expect(() => {
      terminateProcessTree(600, child, {
        platform: "linux",
        killProcess,
        isProcessAlive
      });
    }).not.toThrow();

    expect(killProcess).toHaveBeenCalledWith(-600, "SIGTERM");
  });

  it("shell:true child survival detected via isProcessAlive", () => {
    const child = makeChild(700, () => true);
    const killProcess = vi.fn();
    let aliveCalls = 0;
    const isProcessAlive = vi.fn().mockImplementation(() => {
      aliveCalls++;
      return aliveCalls === 1;
    });

    terminateProcessTree(700, child, {
      platform: "linux",
      killProcess,
      isProcessAlive
    });

    expect(killProcess).toHaveBeenNthCalledWith(1, -700, "SIGTERM");
    expect(killProcess).toHaveBeenNthCalledWith(2, 700, "SIGTERM");
    expect(killProcess).toHaveBeenCalledTimes(2);
  });
});

describe("process management - unified job PID", () => {
  it("updates PID only while the job is running", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-worker-pid-"));
    try {
      const job = createJobStore(cwd).create({ kind: "implement", task: "work", request: { cwd } });
      await transitionJob(cwd, job.id, { status: "running", phase: "starting", summary: "starting" });
      await updateRunningJobPid(cwd, job.id, 444);
      expect(readJob(cwd, job.id)?.pid).toBe(444);

      await transitionJob(cwd, job.id, { status: "cancelled", summary: "cancelled" });
      await updateRunningJobPid(cwd, job.id, 555);
      expect(readJob(cwd, job.id)).toMatchObject({ status: "cancelled", pid: null });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
