import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runMimoCliStreaming, terminateProcessTree } from "../../src/compose/streaming-runner.js";

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

describe("streaming MiMo CLI runner", () => {
  it("streams JSONL events and returns captured stdout", async () => {
    const seen: string[] = [];
    const result = await runMimoCliStreaming("E:/project/app", ["run"], {
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
          pid: number;
          kill: () => boolean;
        };
        child.pid = 123;
        child.stdout = Readable.from([
          "{\"type\":\"message\",\"text\":\"hello\"}\n",
          "{\"type\":\"tool\",\"tool\":\"bash\",\"status\":\"completed\"}\n"
        ]);
        child.stderr = Readable.from([""]);
        child.kill = () => true;
        queueMicrotask(() => child.emit("close", 0));
        return child;
      },
      onLine: (line) => seen.push(line)
    });

    expect(result.exitCode).toBe(0);
    expect(result.pid).toBe(123);
    expect(seen).toEqual([
      "{\"type\":\"message\",\"text\":\"hello\"}",
      "{\"type\":\"tool\",\"tool\":\"bash\",\"status\":\"completed\"}"
    ]);
    expect(result.stdout).toContain("\"hello\"");
  });

  it("returns stderr and nonzero exit code", async () => {
    const result = await runMimoCliStreaming("E:/project/app", ["run"], {
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
          pid: number;
          kill: () => boolean;
        };
        child.pid = 456;
        child.stdout = Readable.from([""]);
        child.stderr = Readable.from(["failed\n"]);
        child.kill = () => true;
        queueMicrotask(() => child.emit("close", 2));
        return child;
      }
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("failed\n");
  });

  it("terminates the process tree on timeout", async () => {
    let killedPid: number | null | undefined;
    const result = await runMimoCliStreaming("E:/project/app", ["run"], {
      timeoutMs: 1,
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
          pid: number;
          kill: () => boolean;
        };
        child.pid = 789;
        child.stdout = Readable.from([""]);
        child.stderr = Readable.from([""]);
        child.kill = () => true;
        return child;
      },
      terminateProcessTree: (pid, child) => {
        killedPid = pid;
        queueMicrotask(() => child.emit("close", null));
      }
    });

    expect(killedPid).toBe(789);
    expect(result.exitCode).toBe(124);
  });

  it("terminates the process when abort signal fires", async () => {
    const ac = new AbortController();
    let killedPid: number | null | undefined;
    let terminateCalled = false;
    let childRef!: ReturnType<typeof makeChild>;

    const runPromise = runMimoCliStreaming("E:/project/app", ["run"], {
      signal: ac.signal,
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
          pid: number;
          kill: () => boolean;
        };
        child.pid = 1010;
        child.stdout = new Readable({ read() {} });
        child.stderr = new Readable({ read() {} });
        child.kill = () => true;
        childRef = child as any;
        return child;
      },
      terminateProcessTree: (pid, child) => {
        terminateCalled = true;
        killedPid = pid;
        child.stdout!.push(null);
        child.stderr!.push(null);
        child.emit("close", null);
      }
    });

    await new Promise((r) => setImmediate(r));
    ac.abort();
    await new Promise((r) => setImmediate(r));

    expect(terminateCalled).toBe(true);
    expect(killedPid).toBe(1010);

    const result = await runPromise;
    expect(result.exitCode).toBe(124);
  });
});

describe("terminateProcessTree", () => {
  it("kills the process group on POSIX", () => {
    const child = makeChild(100);
    const killProcess = vi.fn();
    const isProcessAlive = vi.fn().mockReturnValue(false);

    terminateProcessTree(100, child, {
      platform: "linux",
      killProcess,
      isProcessAlive
    });

    expect(killProcess).toHaveBeenCalledWith(-100, "SIGTERM");
  });

  it("falls back to direct child kill when process group kill fails", () => {
    const child = makeChild(200, () => true);
    const killProcess = vi.fn()
      .mockImplementationOnce(() => { throw new Error("ESRCH"); })
      .mockReturnValueOnce(true);
    let aliveCheckCount = 0;
    const isProcessAlive = vi.fn().mockImplementation(() => {
      aliveCheckCount++;
      return aliveCheckCount === 1;
    });

    terminateProcessTree(200, child, {
      platform: "linux",
      killProcess,
      isProcessAlive
    });

    expect(killProcess).toHaveBeenNthCalledWith(1, -200, "SIGTERM");
    expect(killProcess).toHaveBeenNthCalledWith(2, 200, "SIGTERM");
  });

  it("verifies the process is dead after kill and retries if still alive", () => {
    const child = makeChild(300, () => true);
    const killProcess = vi.fn().mockReturnValue(true);
    let aliveCalls = 0;
    const isProcessAlive = vi.fn().mockImplementation(() => {
      aliveCalls++;
      return aliveCalls <= 1;
    });

    terminateProcessTree(300, child, {
      platform: "linux",
      killProcess,
      isProcessAlive
    });

    expect(killProcess).toHaveBeenCalledTimes(2);
    expect(killProcess).toHaveBeenNthCalledWith(1, -300, "SIGTERM");
    expect(killProcess).toHaveBeenNthCalledWith(2, 300, "SIGTERM");
  });

  it("uses taskkill /T on Windows", () => {
    const child = makeChild(400);
    const spawnSync = vi.fn();
    const isProcessAlive = vi.fn().mockReturnValue(false);

    terminateProcessTree(400, child, {
      platform: "win32",
      spawnSync,
      isProcessAlive
    });

    expect(spawnSync).toHaveBeenCalledWith("taskkill", ["/PID", "400", "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
  });

  it("falls back to child.kill when pid is null", () => {
    const child = makeChild(500, () => true);
    const killProcess = vi.fn();
    const killSpy = vi.spyOn(child, "kill");

    terminateProcessTree(null, child, {
      platform: "linux",
      killProcess
    });

    expect(killProcess).not.toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalled();
  });
});
