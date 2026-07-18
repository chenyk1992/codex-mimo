import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runMimoCliStreaming, terminateProcessTree } from "../../src/mimo/streaming-runner.js";

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

  it("decodes stdout and stderr as UTF-8 for Windows-safe JSONL output", async () => {
    const sample = "基于 Windows 本地执行器 — 🎬";
    const stdout = Readable.from([
      Buffer.from(`${JSON.stringify({ type: "message", text: sample })}\n`, "utf-8")
    ]);
    const stderr = Readable.from([
      Buffer.from(`诊断输出 ${sample}\n`, "utf-8")
    ]);
    const stdoutEncoding = vi.spyOn(stdout, "setEncoding");
    const stderrEncoding = vi.spyOn(stderr, "setEncoding");
    const seen: string[] = [];

    const result = await runMimoCliStreaming("E:/project/app", ["run"], {
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
          pid: number;
          kill: () => boolean;
        };
        child.pid = 457;
        child.stdout = stdout;
        child.stderr = stderr;
        child.kill = () => true;
        queueMicrotask(() => child.emit("close", 0));
        return child;
      },
      onLine: (line) => seen.push(line)
    });

    expect(stdoutEncoding).toHaveBeenCalledWith("utf-8");
    expect(stderrEncoding).toHaveBeenCalledWith("utf-8");
    expect(seen).toEqual([JSON.stringify({ type: "message", text: sample })]);
    expect(result.stdout).toContain(sample);
    expect(result.stderr).toContain(sample);
  });

  it("passes custom environment to the spawned process", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;

    const result = await runMimoCliStreaming("E:/project/app", ["run"], {
      env: { CODEX_MIMO_INVOCATION_ID: "inv-stream" },
      spawnProcess: (_cwd, _args, env) => {
        seenEnv = env;
        const child = makeChild(654);
        queueMicrotask(() => child.emit("close", 0));
        return child;
      }
    });

    expect(result.exitCode).toBe(0);
    expect(seenEnv).toMatchObject({
      CODEX_MIMO_INVOCATION_ID: "inv-stream",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8"
    });
  });

  it("omits protected environment keys after merging the parent and callback environment", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;

    await runMimoCliStreaming("E:/project/app", ["run"], {
      env: {
        CODEX_MIMO_CALLBACK_TOKEN: "callback-token",
        WEBHOOK_SECRET: "must-not-win"
      },
      omitEnv: ["WEBHOOK_SECRET"],
      spawnProcess: (_cwd, _args, env) => {
        seenEnv = env;
        const child = makeChild(655);
        queueMicrotask(() => child.emit("close", 0));
        return child;
      }
    });

    expect(seenEnv?.WEBHOOK_SECRET).toBeUndefined();
    expect(seenEnv).toMatchObject({
      CODEX_MIMO_CALLBACK_TOKEN: "callback-token",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8"
    });
  });

  it("does not select a differently-cased protected Windows ComSpec as the shell", async () => {
    let selection: { command: string; shell: boolean | string } | undefined;

    await runMimoCliStreaming("E:/project/app", ["run"], {
      env: { cOmSpEc: "windows-shell-secret" },
      omitEnv: ["COMSPEC"],
      platform: "win32",
      spawnProcess: (_cwd, _args, env, selected) => {
        selection = selected;
        expect(Object.keys(env ?? {}).some((name) => name.toLowerCase() === "comspec")).toBe(false);
        const child = makeChild(656);
        queueMicrotask(() => child.emit("close", 0));
        return child;
      }
    } as Parameters<typeof runMimoCliStreaming>[2] & { platform: NodeJS.Platform });

    expect(selection).toEqual({ command: "mimo", shell: "cmd.exe" });
  });

  it("awaits asynchronous onStart before completing", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let settled = false;
    const run = runMimoCliStreaming("E:/project/app", ["run"], {
      spawnProcess: () => {
        const child = makeChild(655);
        queueMicrotask(() => child.emit("close", 0));
        return child;
      },
      onStart: async () => held
    }).then((result) => {
      settled = true;
      return result;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    await expect(run).resolves.toMatchObject({ exitCode: 0 });
  });

  it("kills the child and rejects when asynchronous onStart fails", async () => {
    const startup = new Error("PID persistence failed");
    const child = makeChild(656);
    const terminate = vi.fn((_pid, child) => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    });

    await expect(runMimoCliStreaming("E:/project/app", ["run"], {
      timeoutMs: 10_000,
      spawnProcess: () => child,
      terminateProcessTree: terminate,
      onStart: async () => { throw startup; }
    })).rejects.toBe(startup);

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate.mock.calls[0][0]).toBe(656);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
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
    expect(result.terminationReason).toBe("process_timeout");
  });

  it("fires onTimeoutWarning before hard kill", async () => {
    let warningFired = false;
    let warningPid: number | null | undefined;

    const result = await runMimoCliStreaming("E:/project/app", ["run"], {
      timeoutMs: 1000,
      timeoutWarningMs: 500,
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
          pid: number;
          kill: () => boolean;
        };
        child.pid = 888;
        child.stdout = Readable.from([""]);
        child.stderr = Readable.from([""]);
        child.kill = () => true;
        return child;
      },
      terminateProcessTree: (_pid, child) => {
        child.emit("close", null);
      },
      onTimeoutWarning: (pid) => {
        warningFired = true;
        warningPid = pid;
      }
    });

    expect(warningFired).toBe(true);
    expect(warningPid).toBe(888);
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
    expect(result.terminationReason).toBe("host_abort");
  });

  it("does not resolve cancellation before asynchronous process-group termination completes", async () => {
    const abort = new AbortController();
    const child = makeChild(1011);
    let releaseTermination!: () => void;
    const terminationHeld = new Promise<void>((resolve) => { releaseTermination = resolve; });
    let settled = false;
    const run = runMimoCliStreaming("E:/project/app", ["run"], {
      signal: abort.signal,
      spawnProcess: () => child,
      terminateProcessTree: async (_pid, target) => {
        target.emit("close", null);
        await terminationHeld;
      }
    }).then((result) => {
      settled = true;
      return result;
    });

    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseTermination();
    await expect(run).resolves.toMatchObject({ exitCode: 124, terminationReason: "host_abort" });
  });

  it("rejects promptly when process-group termination cannot be confirmed and root stays alive", async () => {
    const abort = new AbortController();
    const child = makeChild(1012);
    const failure = new Error("process group unconfirmed");
    const run = runMimoCliStreaming("E:/project/app", ["run"], {
      signal: abort.signal,
      spawnProcess: () => child,
      terminateProcessTree: async () => { throw failure; }
    });

    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    const outcome = await Promise.race([
      run.then(() => "resolved" as const, (error) => error),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 150))
    ]);
    child.emit("close", null);

    expect(outcome).toBe(failure);
  });

  it("observes close when an already-aborted signal terminates synchronously", async () => {
    const abort = new AbortController();
    abort.abort();
    const child = makeChild(1013);
    const run = runMimoCliStreaming("E:/project/app", ["run"], {
      signal: abort.signal,
      spawnProcess: () => child,
      terminateProcessTree: (_pid, target) => { target.emit("close", null); }
    });

    const outcome = await Promise.race([
      run,
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 150))
    ]);
    if (outcome === "timed_out") child.emit("close", null);

    expect(outcome).not.toBe("timed_out");
    await run;
  });

  it("keeps the first termination reason when timeout and abort race", async () => {
    const abort = new AbortController();
    const child = makeChild(1014);
    let releaseTermination!: () => void;
    const held = new Promise<void>((resolve) => { releaseTermination = resolve; });
    const run = runMimoCliStreaming("E:/project/app", ["run"], {
      signal: abort.signal,
      timeoutMs: 1,
      spawnProcess: () => child,
      terminateProcessTree: async () => held
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort();
    releaseTermination();
    child.emit("close", null);

    await expect(run).resolves.toMatchObject({ terminationReason: "process_timeout" });
  });

  it("disarms timeout as soon as the root closes while output is still draining", async () => {
    const child = makeChild(1015);
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    const terminate = vi.fn();
    const run = runMimoCliStreaming("E:/project/app", ["run"], {
      timeoutMs: 20,
      spawnProcess: () => child,
      terminateProcessTree: terminate
    });

    child.emit("close", 0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    child.stdout.push(null);
    child.stderr.push(null);

    await expect(run).resolves.toMatchObject({ exitCode: 0, terminationReason: undefined });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("destroys stream resources when termination fails before root exit", async () => {
    const abort = new AbortController();
    const child = makeChild(1016);
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    const failure = new Error("termination failed");
    const run = runMimoCliStreaming("E:/project/app", ["run"], {
      signal: abort.signal,
      spawnProcess: () => child,
      terminateProcessTree: async () => { throw failure; }
    });

    abort.abort();
    await expect(run).rejects.toBe(failure);

    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("end")).toBe(0);
  });

  (process.platform === "win32" ? it.skip : it)(
    "removes a real detached process group even when the root exits before its descendant",
    async () => {
      const abort = new AbortController();
      const childSource = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
      const rootSource = [
        "const {spawn}=require('node:child_process')",
        `const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'ignore'})`,
        "console.log(child.pid)",
        "process.on('SIGTERM',()=>process.exit(0))",
        "setInterval(()=>{},1000)"
      ].join(";");
      let groupPid: number | undefined;
      let descendantPid: number | undefined;

      try {
        const result = await runMimoCliStreaming(process.cwd(), [], {
          signal: abort.signal,
          spawnProcess: () => {
            const processGroup = spawn(process.execPath, ["-e", rootSource], {
              detached: true,
              stdio: ["ignore", "pipe", "pipe"]
            });
            groupPid = processGroup.pid;
            return processGroup;
          },
          onLine: (line) => {
            descendantPid = Number(line);
            abort.abort();
          }
        });

        expect(result).toMatchObject({ exitCode: 124, terminationReason: "host_abort" });
        expect(groupPid).toBeTypeOf("number");
        expect(descendantPid).toBeTypeOf("number");
        expect(isProcessRunning(-(groupPid as number))).toBe(false);
        expect(isProcessRunning(descendantPid as number)).toBe(false);
      } finally {
        if (groupPid) bestEffortKill(-groupPid);
        if (descendantPid) bestEffortKill(descendantPid);
      }
    }
  );
});

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function bestEffortKill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Test cleanup only.
  }
}

describe("terminateProcessTree", () => {
  it("kills the process group on POSIX", async () => {
    const child = makeChild(100);
    const signalProcessGroup = vi.fn(() => ({ status: "sent" as const, evidence: "TERM sent" }));
    const probeProcessGroup = vi.fn(() => ({ status: "not_running" as const, evidence: "group gone" }));

    await terminateProcessTree(100, child, {
      platform: "linux",
      signalProcessGroup,
      probeProcessGroup
    });

    expect(signalProcessGroup).toHaveBeenCalledWith(100, "SIGTERM");
  });

  it("keeps probing the process group when the root exits but a descendant remains", async () => {
    const child = makeChild(200);
    const signalProcessGroup = vi.fn(() => ({ status: "sent" as const, evidence: "TERM sent" }));
    const probeProcessGroup = vi.fn()
      .mockReturnValueOnce({ status: "running", evidence: "descendant alive" })
      .mockReturnValueOnce({ status: "not_running", evidence: "group gone" });
    const wait = vi.fn(async () => undefined);

    await terminateProcessTree(200, child, {
      platform: "linux",
      signalProcessGroup,
      probeProcessGroup,
      wait
    });

    expect(probeProcessGroup).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(signalProcessGroup).toHaveBeenCalledTimes(1);
  });

  it("escalates the whole process group to SIGKILL after bounded TERM probes", async () => {
    const child = makeChild(300);
    const signalProcessGroup = vi.fn(() => ({ status: "sent" as const, evidence: "sent" }));
    const probeProcessGroup = vi.fn()
      .mockReturnValueOnce({ status: "running", evidence: "ignored TERM" })
      .mockReturnValueOnce({ status: "not_running", evidence: "killed" });

    await terminateProcessTree(300, child, {
      platform: "linux",
      signalProcessGroup,
      probeProcessGroup,
      graceChecks: 1
    });

    expect(signalProcessGroup.mock.calls).toEqual([[300, "SIGTERM"], [300, "SIGKILL"]]);
  });

  it("rejects when bounded TERM and KILL probes cannot confirm process-group exit", async () => {
    const child = makeChild(301);

    await expect(terminateProcessTree(301, child, {
      platform: "linux",
      signalProcessGroup: vi.fn(() => ({ status: "sent" as const, evidence: "sent" })),
      probeProcessGroup: vi.fn(() => ({ status: "running" as const, evidence: "still running" })),
      graceChecks: 1
    })).rejects.toThrow(/could not be confirmed.*still running/i);
  });

  it("uses taskkill /T on Windows and waits for delayed process exit", async () => {
    const child = makeChild(400);
    const spawnSync = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const probeWindowsProcess = vi.fn()
      .mockReturnValueOnce({ status: "running", evidence: "alive before kill" })
      .mockReturnValueOnce({ status: "running", evidence: "exit pending" })
      .mockReturnValueOnce({ status: "not_running", evidence: "gone" });
    const wait = vi.fn(async () => undefined);

    await terminateProcessTree(400, child, {
      platform: "win32",
      spawnSync,
      probeWindowsProcess,
      wait,
      graceChecks: 2
    });

    expect(spawnSync).toHaveBeenCalledWith("taskkill", ["/PID", "400", "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true
    });
    expect(probeWindowsProcess).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledOnce();
  });

  it("treats an already-gone Windows process as successful without taskkill", async () => {
    const child = makeChild(401);
    const spawnSync = vi.fn();

    await terminateProcessTree(401, child, {
      platform: "win32",
      spawnSync,
      probeWindowsProcess: vi.fn(() => ({ status: "not_running", evidence: "gone" }))
    });

    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("rejects promptly when taskkill fails and the Windows child never closes", async () => {
    const abort = new AbortController();
    const child = makeChild(402);
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    const run = runMimoCliStreaming("E:/project/app", ["run"], {
      signal: abort.signal,
      spawnProcess: () => child,
      terminateProcessTree: (pid, target) => terminateProcessTree(pid, target, {
        platform: "win32",
        spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "access denied" })),
        probeWindowsProcess: vi.fn(() => ({ status: "running", evidence: "tree live" })),
        graceChecks: 1
      })
    });

    abort.abort();

    await expect(Promise.race([
      run,
      new Promise((_, reject) => setTimeout(() => reject(new Error("runner hung")), 150))
    ])).rejects.toThrow(/taskkill.*access denied.*tree live/i);
    expect(child.listenerCount("close")).toBe(0);
  });

  it("falls back to child.kill when pid is null", async () => {
    const child = makeChild(500, () => true);
    const killProcess = vi.fn();
    const killSpy = vi.spyOn(child, "kill");

    await terminateProcessTree(null, child, { platform: "linux", killProcess });

    expect(killProcess).not.toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalled();
  });
});
