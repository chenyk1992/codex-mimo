import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { terminateProcessTree } from "../../../src/mimo/streaming-runner.js";
import { createJobStore, readJob } from "../../../src/core/job-store.js";
import { transitionJob, updateRunningJobProcess } from "../../../src/core/job-transition.js";

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
  it("Windows: uses taskkill /PID /T /F", async () => {
    const child = makeChild(400);
    const spawnSync = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const probeWindowsProcess = vi.fn()
      .mockReturnValueOnce({ status: "running", evidence: "alive" })
      .mockReturnValueOnce({ status: "not_running", evidence: "gone" });

    await terminateProcessTree(400, child, {
      platform: "win32",
      spawnSync,
      probeWindowsProcess
    });

    expect(spawnSync).toHaveBeenCalledWith("taskkill", ["/PID", "400", "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true
    });
  });

  it("Unix: SIGTERM group then SIGKILL fallback when the group survives", async () => {
    const child = makeChild(500);
    const signalProcessGroup = vi.fn(() => ({ status: "sent" as const, evidence: "sent" }));
    const probeProcessGroup = vi.fn()
      .mockReturnValueOnce({ status: "running", evidence: "survived TERM" })
      .mockReturnValueOnce({ status: "not_running", evidence: "group gone" });

    await terminateProcessTree(500, child, {
      platform: "linux",
      signalProcessGroup,
      probeProcessGroup,
      graceChecks: 1
    });

    expect(signalProcessGroup.mock.calls).toEqual([[500, "SIGTERM"], [500, "SIGKILL"]]);
  });

  it("already-exited process does not throw", async () => {
    const child = makeChild(600, () => true);
    const killProcess = vi.fn(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });

    await expect(terminateProcessTree(600, child, {
      platform: "linux",
      killProcess
    })).resolves.toBeUndefined();

    expect(killProcess).toHaveBeenCalledWith(-600, "SIGTERM");
  });

  it("root exit does not hide a surviving process-group descendant", async () => {
    const child = makeChild(700);
    const signalProcessGroup = vi.fn(() => ({ status: "sent" as const, evidence: "TERM sent" }));
    const probeProcessGroup = vi.fn()
      .mockReturnValueOnce({ status: "running", evidence: "descendant alive" })
      .mockReturnValueOnce({ status: "not_running", evidence: "group gone" });

    await terminateProcessTree(700, child, {
      platform: "linux",
      signalProcessGroup,
      probeProcessGroup,
      wait: async () => undefined
    });

    expect(signalProcessGroup).toHaveBeenCalledOnce();
    expect(probeProcessGroup).toHaveBeenCalledTimes(2);
  });
});

describe("process management - unified job PID", () => {
  it("updates PID only while the job is running", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-worker-pid-"));
    try {
      const job = createJobStore(cwd).create({ kind: "implement", task: "work", request: { cwd } });
      await transitionJob(cwd, job.id, { status: "running", phase: "starting", summary: "starting" });
      await updateRunningJobProcess(cwd, job.id, 444, "start-444");
      expect(readJob(cwd, job.id)?.pid).toBe(444);

      await transitionJob(cwd, job.id, { status: "cancelled", summary: "cancelled" });
      await updateRunningJobProcess(cwd, job.id, 555, "start-555");
      expect(readJob(cwd, job.id)).toMatchObject({ status: "cancelled", pid: null });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
