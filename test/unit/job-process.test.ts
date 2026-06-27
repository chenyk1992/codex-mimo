import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { buildWorkerArgs, buildWorkerProcessLaunch, spawnJobWorker, terminateJobProcess } from "../../src/core/job-process.js";

function fakeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
  child.pid = pid;
  child.unref = vi.fn();
  return child;
}

describe("job process", () => {
  it("builds compose worker args", () => {
    expect(buildWorkerArgs("compose", "job-1")).toEqual(["compose-worker", "--job-id", "job-1"]);
  });

  it("launches workers from the plugin root and passes project cwd explicitly", () => {
    const launch = buildWorkerProcessLaunch(
      "E:/ideaProjects/lex-vault",
      "compose",
      "job-1",
      "file:///C:/Users/Administrator/.codex/plugins/cache/personal/codex-mimocode/0.1.0/dist/core/job-process.js"
    );

    expect(path.isAbsolute(launch.entryPoint)).toBe(true);
    expect(launch.entryPoint.replace(/\\/g, "/")).toBe(
      "C:/Users/Administrator/.codex/plugins/cache/personal/codex-mimocode/0.1.0/dist/cli/main.js"
    );
    expect(launch.cwd.replace(/\\/g, "/")).toBe(
      "C:/Users/Administrator/.codex/plugins/cache/personal/codex-mimocode/0.1.0"
    );
    expect(launch.args).toEqual([
      launch.entryPoint,
      "compose-worker",
      "--job-id",
      "job-1",
      "--cwd",
      "E:/ideaProjects/lex-vault"
    ]);
  });

  it("terminates finite pids through injected killer", () => {
    const kill = vi.fn();
    terminateJobProcess(123, { killProcess: kill });
    expect(kill).toHaveBeenCalledWith(123);
  });

  it("terminates process trees on Windows by default", () => {
    const spawnSync = vi.fn();
    terminateJobProcess(123, { platform: "win32", spawnSync });
    expect(spawnSync).toHaveBeenCalledWith("taskkill", ["/PID", "123", "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
  });

  it("terminates process groups on POSIX by default", () => {
    const killProcess = vi.fn();
    terminateJobProcess(123, { platform: "linux", killProcess });
    expect(killProcess).toHaveBeenCalledWith(-123);
  });

  it("ignores missing pids", () => {
    const kill = vi.fn();
    terminateJobProcess(null, { killProcess: kill });
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("spawnJobWorker", () => {
  it("returns the child pid when spawn succeeds", () => {
    const child = fakeChild(42);
    const pid = spawnJobWorker("E:/project", "compose", "job-1", {
      spawnProcess: () => child
    });
    expect(pid).toBe(42);
  });

  it("spawns the Node worker directly without a shell", () => {
    const child = fakeChild(42);
    const spawnProcess = vi.fn(() => child);
    spawnJobWorker("E:/project", "compose", "job-1", { spawnProcess });

    expect(spawnProcess).toHaveBeenCalled();
    expect(spawnProcess.mock.calls[0][2]).toMatchObject({ shell: false });
  });

  it("forwards child error events to onError callback", () => {
    const child = fakeChild(50);
    const onError = vi.fn();
    spawnJobWorker("E:/project", "compose", "job-1", {
      spawnProcess: () => child,
      onError
    });
    const error = new Error("spawn failed");
    child.emit("error", error);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("forwards child exit events to onExit callback", () => {
    const child = fakeChild(60);
    const onExit = vi.fn();
    spawnJobWorker("E:/project", "compose", "job-1", {
      spawnProcess: () => child,
      onExit
    });
    child.emit("exit", 1, null);
    expect(onExit).toHaveBeenCalledWith(1, null);
  });

  it("works without callbacks (backward compatible)", () => {
    const child = fakeChild(70);
    const pid = spawnJobWorker("E:/project", "compose", "job-1", {
      spawnProcess: () => child
    });
    expect(pid).toBe(70);
    child.emit("exit", 1, null);
  });
});
