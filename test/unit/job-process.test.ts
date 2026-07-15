import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn };
});

import {
  spawnJobWorker,
  spawnNotificationWorker,
  spawnWorker,
  terminateJobProcess
} from "../../src/core/job-process.js";

function fakeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
  child.pid = pid;
  child.unref = vi.fn();
  return child;
}

beforeEach(() => spawn.mockReset());

describe("worker processes", () => {
  it.each([
    ["job-worker", "job-1", ["job-worker", "--cwd", "E:/project", "--job-id", "job-1"]],
    ["notify-worker", undefined, ["notify-worker", "--cwd", "E:/project"]]
  ] as const)("spawns only the %s command", (command, jobId, suffix) => {
    const child = fakeChild(42);
    spawn.mockReturnValue(child);

    expect(spawnWorker(command, "E:/project", jobId)).toBe(42);

    const [executable, args, options] = spawn.mock.calls[0];
    expect(executable).toBe(process.execPath);
    expect(args.slice(1)).toEqual(suffix);
    expect(args[0].replace(/\\/g, "/")).toMatch(/\/(?:src|dist)\/cli\/main\.js$/);
    expect(options).toMatchObject({
      cwd: "E:/project",
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    expect(options.env).toMatchObject({ PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("provides thin job and notification worker launchers", () => {
    spawn.mockReturnValueOnce(fakeChild(11)).mockReturnValueOnce(fakeChild(12));

    expect(spawnJobWorker("E:/project", "job-1")).toBe(11);
    expect(spawnNotificationWorker("E:/project")).toBe(12);

    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(["job-worker", "--job-id", "job-1"]));
    expect(spawn.mock.calls[1][1]).toEqual(expect.arrayContaining(["notify-worker"]));
    expect(spawn.mock.calls[1][1]).not.toEqual(expect.arrayContaining(["compose-worker"]));
  });
});

describe("terminateJobProcess", () => {
  it("terminates finite pids through injected killer", () => {
    const kill = vi.fn();
    terminateJobProcess(123, { killProcess: kill });
    expect(kill).toHaveBeenCalledWith(123);
  });

  it("terminates process trees on Windows", () => {
    const spawnSync = vi.fn();
    terminateJobProcess(123, { platform: "win32", spawnSync });
    expect(spawnSync).toHaveBeenCalledWith("taskkill", ["/PID", "123", "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
  });

  it("terminates process groups on POSIX", () => {
    const killProcess = vi.fn();
    terminateJobProcess(123, { platform: "linux", killProcess });
    expect(killProcess).toHaveBeenCalledWith(-123);
  });
});
