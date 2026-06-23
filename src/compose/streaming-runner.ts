import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { Readable } from "node:stream";

export interface StreamingRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  pid: number | null;
}

interface StreamingChildProcess extends EventEmitter {
  stdout?: Readable | null;
  stderr?: Readable | null;
  pid?: number;
  kill: () => boolean;
}

interface StreamingRunOptions {
  timeoutMs?: number;
  onLine?: (line: string) => void;
  onStderr?: (chunk: string) => void;
  spawnProcess?: (cwd: string, args: string[]) => StreamingChildProcess;
}

function defaultSpawn(cwd: string, args: string[]): StreamingChildProcess {
  return spawn("mimo", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

export async function runMimoCliStreaming(
  cwd: string,
  args: string[],
  options: StreamingRunOptions = {}
): Promise<StreamingRunResult> {
  const child = (options.spawnProcess ?? defaultSpawn)(cwd, args);
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  let timedOut = false;

  const timeout = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs)
    : null;

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
    child.on("close", (code: number | null) => resolve(timedOut ? 124 : code ?? 1));
  });

  if (timeout) clearTimeout(timeout);
  await Promise.all([stdoutDone, stderrDone]);

  return {
    stdout: stdoutParts.join(""),
    stderr: stderrParts.join(""),
    exitCode,
    pid: child.pid ?? null
  };
}
