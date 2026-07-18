import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn };
});

import {
  captureProcessIdentity,
  spawnJobWorker,
  spawnNotificationWorker,
  spawnWorker,
  terminateJobProcess,
  terminateOwnedJobProcess,
  verifyProcessIdentity
} from "../../src/core/job-process.js";
import * as jobProcess from "../../src/core/job-process.js";

function fakeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
  child.pid = pid;
  child.unref = vi.fn();
  return child;
}

beforeEach(() => spawn.mockReset());

describe("worker processes", () => {
  it("provides one internal workspace supervisor launcher", () => {
    const processApi = jobProcess as unknown as {
      spawnJobSupervisor?: (cwd: string) => number;
    };
    spawn.mockReturnValue(fakeChild(10));

    expect(processApi.spawnJobSupervisor).toBeTypeOf("function");
    expect(processApi.spawnJobSupervisor!("E:/project")).toBe(10);
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(["job-supervisor", "--cwd", "E:/project"]));
  });

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

describe("owned process identity", () => {
  it("does not kill a reused PID whose startup identity differs", () => {
    const killProcessTree = vi.fn();

    const result = terminateOwnedJobProcess(123, "start-1", {
      platform: "win32",
      captureIdentity: vi.fn(() => ({
        status: "running" as const,
        identity: "start-2",
        evidence: "pid 123 now belongs to start-2"
      })),
      killProcessTree
    });

    expect(result).toMatchObject({ status: "identity_mismatch" });
    expect(killProcessTree).not.toHaveBeenCalled();
  });

  it("does not claim safe termination when killing fails", () => {
    const result = terminateOwnedJobProcess(123, "start-1", {
      platform: "win32",
      captureIdentity: vi.fn(() => ({
        status: "running" as const,
        identity: "start-1",
        evidence: "matched"
      })),
      killProcessTree: vi.fn(() => ({ ok: false, evidence: "taskkill exit 1" }))
    });

    expect(result).toEqual({ status: "unconfirmed", evidence: "taskkill exit 1" });
  });

  it("does not claim safe termination while the same process remains alive", () => {
    const captureIdentity = vi.fn(() => ({
      status: "running" as const,
      identity: "start-1",
      evidence: "still alive"
    }));

    const result = terminateOwnedJobProcess(123, "start-1", {
      platform: "win32",
      captureIdentity,
      killProcessTree: vi.fn(() => ({ ok: true, evidence: "kill sent" }))
    });

    expect(result).toEqual({ status: "unconfirmed", evidence: "still alive" });
    expect(captureIdentity).toHaveBeenCalledTimes(2);
  });

  it("kills only a matching process and confirms that it exited", () => {
    const captureIdentity = vi.fn()
      .mockReturnValueOnce({ status: "running", identity: "start-1", evidence: "matched" })
      .mockReturnValueOnce({ status: "not_running", evidence: "gone" });
    const killProcessTree = vi.fn(() => ({ ok: true, evidence: "kill sent" }));

    const result = terminateOwnedJobProcess(123, "start-1", {
      platform: "win32",
      captureIdentity,
      killProcessTree
    });

    expect(result).toEqual({ status: "terminated", evidence: "gone" });
    expect(killProcessTree).toHaveBeenCalledWith(123);
  });

  it("exposes independently injectable capture and verification", () => {
    const query = vi.fn(() => ({
      status: "running" as const,
      identity: "start-1",
      evidence: "query"
    }));

    expect(captureProcessIdentity(123, { query })).toMatchObject({
      status: "running",
      identity: "start-1"
    });
    expect(verifyProcessIdentity(123, "start-1", { captureIdentity: query })).toMatchObject({
      status: "match"
    });
  });

  it("captures a macOS process identity from its stable start time", () => {
    const spawnSync = vi.fn(() => ({
      status: 0,
      stdout: "Wed Jul 16 12:34:56 2026\n",
      stderr: ""
    }));

    expect(captureProcessIdentity(123, { platform: "darwin", spawnSync })).toEqual({
      status: "running",
      identity: "darwin:Wed Jul 16 12:34:56 2026",
      evidence: "POSIX process start time Wed Jul 16 12:34:56 2026."
    });
    expect(spawnSync).toHaveBeenCalledWith(
      "ps",
      ["-o", "lstart=", "-p", "123"],
      { encoding: "utf8" }
    );
  });

  it("fails safe without querying an unsupported platform", () => {
    const spawnSync = vi.fn();

    expect(captureProcessIdentity(123, { platform: "aix", spawnSync })).toEqual({
      status: "unconfirmed",
      evidence: "Process identity is unsupported on platform aix."
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("does not treat a dead root as termination while its POSIX process group remains alive", () => {
    const captureIdentity = vi.fn()
      .mockReturnValueOnce({ status: "running", identity: "start-1", evidence: "matched" })
      .mockReturnValue({ status: "not_running", evidence: "root exited" });
    const signalProcessGroup = vi.fn(() => ({ status: "sent" as const, evidence: "sent" }));
    const probeProcessGroup = vi.fn()
      .mockReturnValueOnce({ status: "running", evidence: "child remains" })
      .mockReturnValueOnce({ status: "running", evidence: "child remains" })
      .mockReturnValueOnce({ status: "not_running", evidence: "group gone" });

    const result = terminateOwnedJobProcess(123, "start-1", {
      platform: "linux",
      captureIdentity,
      killProcessTree: vi.fn(() => ({ ok: true, evidence: "legacy kill" })),
      signalProcessGroup,
      probeProcessGroup,
      wait: vi.fn(),
      graceChecks: 2
    });

    expect(result).toEqual({ status: "terminated", evidence: "group gone" });
    expect(signalProcessGroup.mock.calls).toEqual([[123, "SIGTERM"], [123, "SIGKILL"]]);
  });

  it("waits a bounded grace period for a POSIX process group to exit after TERM", () => {
    const wait = vi.fn();
    const signalProcessGroup = vi.fn(() => ({ status: "sent" as const, evidence: "sent" }));
    const probeProcessGroup = vi.fn()
      .mockReturnValueOnce({ status: "running", evidence: "still running" })
      .mockReturnValueOnce({ status: "not_running", evidence: "exited after grace" });

    const result = terminateOwnedJobProcess(123, "start-1", {
      platform: "darwin",
      captureIdentity: vi.fn(() => ({ status: "running", identity: "start-1", evidence: "matched" })),
      killProcessTree: vi.fn(() => ({ ok: true, evidence: "legacy kill" })),
      signalProcessGroup,
      probeProcessGroup,
      wait,
      graceChecks: 3,
      graceIntervalMs: 7
    });

    expect(result).toEqual({ status: "terminated", evidence: "exited after grace" });
    expect(signalProcessGroup).toHaveBeenCalledOnce();
    expect(signalProcessGroup).toHaveBeenCalledWith(123, "SIGTERM");
    expect(wait).toHaveBeenCalledWith(7);
  });

  it("escalates a POSIX process group that ignores TERM to SIGKILL", () => {
    const signalProcessGroup = vi.fn(() => ({ status: "sent" as const, evidence: "sent" }));
    const probeProcessGroup = vi.fn()
      .mockReturnValueOnce({ status: "running", evidence: "running" })
      .mockReturnValueOnce({ status: "running", evidence: "ignored TERM" })
      .mockReturnValueOnce({ status: "not_running", evidence: "killed" });

    const result = terminateOwnedJobProcess(123, "start-1", {
      platform: "linux",
      captureIdentity: vi.fn(() => ({ status: "running", identity: "start-1", evidence: "matched" })),
      killProcessTree: vi.fn(() => ({ ok: true, evidence: "legacy kill" })),
      signalProcessGroup,
      probeProcessGroup,
      wait: vi.fn(),
      graceChecks: 2
    });

    expect(result).toEqual({ status: "terminated", evidence: "killed" });
    expect(signalProcessGroup.mock.calls).toEqual([[123, "SIGTERM"], [123, "SIGKILL"]]);
  });

  it("returns unconfirmed after bounded TERM and KILL checks cannot prove group exit", () => {
    const wait = vi.fn();
    const signalProcessGroup = vi.fn(() => ({ status: "sent" as const, evidence: "sent" }));
    const probeProcessGroup = vi.fn(() => ({ status: "running" as const, evidence: "still alive" }));

    const result = terminateOwnedJobProcess(123, "start-1", {
      platform: "linux",
      captureIdentity: vi.fn(() => ({ status: "running", identity: "start-1", evidence: "matched" })),
      killProcessTree: vi.fn(() => ({ ok: true, evidence: "legacy kill" })),
      signalProcessGroup,
      probeProcessGroup,
      wait,
      graceChecks: 2,
      graceIntervalMs: 3
    });

    expect(result).toEqual({ status: "unconfirmed", evidence: "still alive" });
    expect(signalProcessGroup.mock.calls).toEqual([[123, "SIGTERM"], [123, "SIGKILL"]]);
    expect(probeProcessGroup).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("does not escalate when a POSIX group probe loses permission", () => {
    const signalProcessGroup = vi.fn(() => ({ status: "sent" as const, evidence: "TERM sent" }));

    const result = terminateOwnedJobProcess(123, "start-1", {
      platform: "linux",
      captureIdentity: vi.fn(() => ({ status: "running", identity: "start-1", evidence: "matched" })),
      signalProcessGroup,
      probeProcessGroup: vi.fn(() => ({ status: "unconfirmed", evidence: "EPERM" })),
      wait: vi.fn()
    });

    expect(result).toEqual({ status: "unconfirmed", evidence: "EPERM" });
    expect(signalProcessGroup).toHaveBeenCalledTimes(1);
    expect(signalProcessGroup).toHaveBeenCalledWith(123, "SIGTERM");
  });

  it("treats TERM ESRCH as a process group that already exited", () => {
    const missing = Object.assign(new Error("no such process"), { code: "ESRCH" });
    const killProcess = vi.fn(() => { throw missing; });

    const result = terminateOwnedJobProcess(123, "start-1", {
      platform: "linux",
      captureIdentity: vi.fn(() => ({ status: "running", identity: "start-1", evidence: "matched" })),
      killProcess,
      probeProcessGroup: vi.fn(() => ({ status: "not_running", evidence: "group absent" })),
      wait: vi.fn()
    });

    expect(result).toMatchObject({ status: "terminated" });
    expect(killProcess).toHaveBeenCalledOnce();
    expect(killProcess).toHaveBeenCalledWith(-123, "SIGTERM");
  });

  it("treats KILL ESRCH after the TERM grace period as a process group that exited", () => {
    const missing = Object.assign(new Error("no such process"), { code: "ESRCH" });
    const killProcess = vi.fn()
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => { throw missing; });

    const result = terminateOwnedJobProcess(123, "start-1", {
      platform: "darwin",
      captureIdentity: vi.fn(() => ({ status: "running", identity: "start-1", evidence: "matched" })),
      killProcess,
      probeProcessGroup: vi.fn(() => ({ status: "running", evidence: "still running" })),
      wait: vi.fn(),
      graceChecks: 1
    });

    expect(result).toMatchObject({ status: "terminated" });
    expect(killProcess.mock.calls).toEqual([[-123, "SIGTERM"], [-123, "SIGKILL"]]);
  });

  it.each(["EPERM", "EUNEXPECTED"])("keeps a %s process-group signal failure unconfirmed", (code) => {
    const failure = Object.assign(new Error(code), { code });

    const result = terminateOwnedJobProcess(123, "start-1", {
      platform: "linux",
      captureIdentity: vi.fn(() => ({ status: "running", identity: "start-1", evidence: "matched" })),
      killProcess: vi.fn(() => { throw failure; }),
      probeProcessGroup: vi.fn(() => ({ status: "not_running", evidence: "not authoritative" })),
      wait: vi.fn()
    });

    expect(result).toMatchObject({ status: "unconfirmed" });
  });

  it("exports sync and async process-group termination primitives with one contract", async () => {
    const processApi = jobProcess as unknown as {
      terminatePosixProcessGroupSync?: (pid: number, options: object) => { status: string };
      terminatePosixProcessGroup?: (pid: number, options: object) => Promise<{ status: string }>;
    };
    const syncSignal = vi.fn(() => ({ status: "not_running", evidence: "gone" }));
    const asyncSignal = vi.fn(async () => ({ status: "not_running" as const, evidence: "gone" }));

    expect(processApi.terminatePosixProcessGroupSync).toBeTypeOf("function");
    expect(processApi.terminatePosixProcessGroup).toBeTypeOf("function");
    expect(processApi.terminatePosixProcessGroupSync!(123, { signalProcessGroup: syncSignal }))
      .toMatchObject({ status: "terminated" });
    await expect(processApi.terminatePosixProcessGroup!(123, { signalProcessGroup: asyncSignal }))
      .resolves.toMatchObject({ status: "terminated" });
  });

  it("does not signal an unsupported platform even when identity capture is injected", () => {
    const signalProcessGroup = vi.fn();
    const killProcessTree = vi.fn();

    const result = terminateOwnedJobProcess(123, "start-1", {
      platform: "aix",
      captureIdentity: vi.fn(() => ({ status: "running", identity: "start-1", evidence: "matched" })),
      signalProcessGroup,
      killProcessTree
    });

    expect(result).toEqual({
      status: "unconfirmed",
      evidence: "Owned process termination is unsupported on platform aix."
    });
    expect(signalProcessGroup).not.toHaveBeenCalled();
    expect(killProcessTree).not.toHaveBeenCalled();
  });
});
