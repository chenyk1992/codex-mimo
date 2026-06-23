import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { terminateProcessTree } from "../../../src/compose/streaming-runner.js";

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
