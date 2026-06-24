import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { Readable } from "node:stream";

export type TerminationReason = "process_timeout" | "host_abort" | "user_cancelled";

export interface StreamingRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  pid: number | null;
  terminationReason?: TerminationReason;
}

interface StreamingChildProcess extends EventEmitter {
  stdout?: Readable | null;
  stderr?: Readable | null;
  pid?: number;
  kill: () => boolean;
}

interface StreamingRunOptions {
  onStart?: (pid: number | null) => void;
  timeoutMs?: number;
  timeoutWarningMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  onStderr?: (chunk: string) => void;
  onTimeoutWarning?: (pid: number | null) => void;
  spawnProcess?: (cwd: string, args: string[]) => StreamingChildProcess;
  terminateProcessTree?: (pid: number | null, child: StreamingChildProcess) => void;
}

function defaultSpawn(cwd: string, args: string[]): StreamingChildProcess {
  return spawn("mimo", args, {
    cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: process.platform === "win32"
  });
}

export interface TerminateOptions {
  platform?: NodeJS.Platform;
  killProcess?: (pid: number, signal?: string) => void;
  spawnSync?: typeof spawnSync;
  isProcessAlive?: (pid: number) => boolean;
}

export function terminateProcessTree(
  pid: number | null,
  child: StreamingChildProcess,
  options: TerminateOptions = {}
): void {
  const platform = options.platform ?? process.platform;
  const killProcess = options.killProcess ?? ((targetPid: number, signal?: string) => process.kill(targetPid, signal));
  const spawnSyncFn = options.spawnSync ?? spawnSync;
  const isProcessAlive = options.isProcessAlive ?? ((targetPid: number) => {
    try {
      process.kill(targetPid, 0);
      return true;
    } catch {
      return false;
    }
  });

  if (Number.isFinite(pid)) {
    if (platform === "win32") {
      spawnSyncFn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      return;
    }

    try {
      killProcess(-(pid as number), "SIGTERM");
    } catch {
      // Process group kill failed, fall through to direct kill.
    }

    if (!isProcessAlive(pid as number)) return;

    try {
      killProcess(pid as number, "SIGTERM");
    } catch {
      // Best-effort.
    }

    if (!isProcessAlive(pid as number)) return;

    try {
      killProcess(pid as number, "SIGKILL");
    } catch {
      // Best-effort.
    }

    return;
  }

  child.kill();
}

export async function runMimoCliStreaming(
  cwd: string,
  args: string[],
  options: StreamingRunOptions = {}
): Promise<StreamingRunResult> {
  const child = (options.spawnProcess ?? defaultSpawn)(cwd, args);
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  let terminationReason: TerminationReason | undefined;

  options.onStart?.(child.pid ?? null);

  const terminateTree = (options.terminateProcessTree ?? terminateProcessTree).bind(null);

  const timeout = options.timeoutMs
    ? setTimeout(() => {
        terminationReason = "process_timeout";
        terminateTree(child.pid ?? null, child);
      }, options.timeoutMs)
    : null;

  const warningTimeout = options.timeoutMs && options.timeoutWarningMs && options.onTimeoutWarning
    ? setTimeout(() => {
        options.onTimeoutWarning!(child.pid ?? null);
      }, Math.max(0, options.timeoutMs - options.timeoutWarningMs))
    : null;

  let abortCleanup: (() => void) | undefined;
  if (options.signal) {
    if (options.signal.aborted) {
      terminationReason = "host_abort";
      terminateTree(child.pid ?? null, child);
    } else {
      const onAbort = () => {
        terminationReason = "host_abort";
        terminateTree(child.pid ?? null, child);
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      abortCleanup = () => options.signal!.removeEventListener("abort", onAbort);
    }
  }

  const stdoutDone = new Promise<void>((resolve) => {
    if (!child.stdout) {
      resolve();
      return;
    }

    const reader = readline.createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      stdoutParts.push(`${line}\n`);
      options.onLine?.(line);
    });
    reader.on("close", resolve);
  });

  const stderrDone = new Promise<void>((resolve) => {
    if (!child.stderr) {
      resolve();
      return;
    }

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderrParts.push(chunk);
      options.onStderr?.(chunk);
    });
    child.stderr.on("end", resolve);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code: number | null) => resolve(terminationReason ? 124 : code ?? 1));
  });

  if (timeout) clearTimeout(timeout);
  if (warningTimeout) clearTimeout(warningTimeout);
  abortCleanup?.();
  await Promise.all([stdoutDone, stderrDone]);

  return {
    stdout: stdoutParts.join(""),
    stderr: stderrParts.join(""),
    exitCode,
    pid: child.pid ?? null,
    terminationReason
  };
}
