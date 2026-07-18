import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { execa } from "execa";
import readline from "node:readline";
import type { Readable } from "node:stream";
import { withUtf8ProcessEnv } from "../core/encoding.js";
import {
  terminatePosixProcessGroup,
  type AsyncProcessGroupTerminationOptions,
  type ProcessGroupProbe
} from "../core/job-process.js";
import {
  resolveMimoProcessSelection,
  type MimoProcessSelection
} from "./run-json.js";

export type TerminationReason = "process_timeout" | "host_abort" | "user_cancelled";

export interface StreamingRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  pid: number | null;
  terminationReason?: TerminationReason;
}

export class StreamingProcessStartError extends Error {
  readonly pid: number | null;
  readonly terminationStatus: "confirmed" | "unconfirmed";
  readonly terminationEvidence: string;

  constructor(input: {
    pid: number | null;
    startError: unknown;
    terminationStatus: "confirmed" | "unconfirmed";
    terminationEvidence: string;
  }) {
    super("MiMoCode process startup ownership could not be persisted.", {
      cause: input.startError
    });
    this.name = "StreamingProcessStartError";
    this.pid = input.pid;
    this.terminationStatus = input.terminationStatus;
    this.terminationEvidence = input.terminationEvidence;
  }
}

interface StreamingChildProcess extends EventEmitter {
  stdout?: Readable | null;
  stderr?: Readable | null;
  pid?: number;
  kill: () => boolean;
}

export interface StreamingRunOptions {
  onStart?: (pid: number | null) => Promise<void> | void;
  timeoutMs?: number;
  timeoutWarningMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  omitEnv?: readonly string[];
  platform?: NodeJS.Platform;
  onLine?: (line: string) => void;
  onStderr?: (chunk: string) => void;
  onTimeoutWarning?: (pid: number | null) => void;
  spawnProcess?: (
    cwd: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    selection: MimoProcessSelection
  ) => StreamingChildProcess;
  terminateProcessTree?: (pid: number | null, child: StreamingChildProcess) => Promise<void> | void;
}

function defaultSpawn(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  selection: MimoProcessSelection
): StreamingChildProcess {
  return execa(selection.command, args, {
    cwd,
    detached: process.platform !== "win32",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    reject: false
  });
}

export interface TerminateOptions extends AsyncProcessGroupTerminationOptions {
  platform?: NodeJS.Platform;
  spawnSync?: typeof spawnSync;
  probeWindowsProcess?: (pid: number) => ProcessGroupProbe | PromiseLike<ProcessGroupProbe>;
}

export async function terminateProcessTree(
  pid: number | null,
  child: StreamingChildProcess,
  options: TerminateOptions = {}
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const spawnSyncFn = options.spawnSync ?? spawnSync;

  if (Number.isFinite(pid)) {
    if (platform === "win32") {
      await terminateWindowsProcessTree(pid as number, {
        ...options,
        spawnSync: spawnSyncFn
      });
      return;
    }
    if (platform === "linux" || platform === "darwin") {
      const outcome = await terminatePosixProcessGroup(pid as number, options);
      if (outcome.status === "unconfirmed") {
        throw new Error(`Process-group termination could not be confirmed: ${outcome.evidence}`);
      }
      return;
    }
    child.kill();
    return;
  }

  child.kill();
}

async function terminateWindowsProcessTree(
  pid: number,
  options: TerminateOptions
): Promise<void> {
  const probe = options.probeWindowsProcess ?? probeWindowsProcess;
  const wait = options.wait ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const checks = Number.isInteger(options.graceChecks) && (options.graceChecks as number) > 0
    ? options.graceChecks as number
    : 3;
  const intervalMs = typeof options.graceIntervalMs === "number" &&
      Number.isFinite(options.graceIntervalMs) && options.graceIntervalMs >= 0
    ? options.graceIntervalMs
    : 50;

  const before = await probe(pid);
  if (before.status === "not_running") return;

  const result = (options.spawnSync ?? spawnSync)(
    "taskkill",
    ["/PID", String(pid), "/T", "/F"],
    { encoding: "utf8", windowsHide: true }
  );
  const taskkillDetail = result.error?.message ??
    (String(result.stderr).trim() || `exit ${String(result.status)}`);
  const taskkillError = result.error || result.status !== 0
    ? `taskkill failed: ${taskkillDetail}`
    : undefined;

  let last = before;
  for (let check = 0; check < checks; check += 1) {
    last = await probe(pid);
    if (last.status === "not_running") return;
    if (last.status === "unconfirmed") {
      throw new Error(
        `${taskkillError ? `${taskkillError}; ` : ""}Windows process termination is unconfirmed: ${last.evidence}`
      );
    }
    if (check < checks - 1) await wait(intervalMs);
  }
  throw new Error(
    `${taskkillError ? `${taskkillError}; ` : ""}Windows process termination could not be confirmed: ${last.evidence}`
  );
}

function probeWindowsProcess(pid: number): ProcessGroupProbe {
  try {
    process.kill(pid, 0);
    return { status: "running", evidence: `PID ${pid} is still running.` };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      return { status: "not_running", evidence: `PID ${pid} is not running.` };
    }
    return {
      status: "unconfirmed",
      evidence: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function runMimoCliStreaming(
  cwd: string,
  args: string[],
  options: StreamingRunOptions = {}
): Promise<StreamingRunResult> {
  const platform = options.platform ?? process.platform;
  const childEnv = withUtf8ProcessEnv(options.env, {
    omit: options.omitEnv,
    platform
  });
  const selection = resolveMimoProcessSelection(childEnv, platform);
  const child = (options.spawnProcess ?? defaultSpawn)(cwd, args, childEnv, selection);
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  let terminationReason: TerminationReason | undefined;
  let processClosed = false;
  let timeout: NodeJS.Timeout | null = null;
  let warningTimeout: NodeJS.Timeout | null = null;
  let termination: Promise<void> | null = null;
  const clearTerminationTimers = () => {
    if (timeout) clearTimeout(timeout);
    if (warningTimeout) clearTimeout(warningTimeout);
    timeout = null;
    warningTimeout = null;
  };

  let stdoutReader: readline.Interface | undefined;
  let cleanupStdoutListeners = () => undefined;
  const stdoutDone = new Promise<void>((resolve) => {
    if (!child.stdout) {
      resolve();
      return;
    }

    child.stdout.setEncoding("utf-8");
    const reader = readline.createInterface({ input: child.stdout });
    stdoutReader = reader;
    const onLine = (line: string) => {
      stdoutParts.push(`${line}\n`);
      options.onLine?.(line);
    };
    const onClose = () => resolve();
    cleanupStdoutListeners = () => {
      reader.off("line", onLine);
      reader.off("close", onClose);
    };
    reader.on("line", onLine);
    reader.once("close", onClose);
  });

  let cleanupStderrListeners = () => undefined;
  const stderrDone = new Promise<void>((resolve) => {
    if (!child.stderr) {
      resolve();
      return;
    }

    child.stderr.setEncoding("utf-8");
    const onData = (chunk: string) => {
      stderrParts.push(chunk);
      options.onStderr?.(chunk);
    };
    const onEnd = () => resolve();
    cleanupStderrListeners = () => {
      child.stderr?.off("data", onData);
      child.stderr?.off("end", onEnd);
    };
    child.stderr.on("data", onData);
    child.stderr.once("end", onEnd);
  });

  let cleanupExitListeners = () => undefined;
  const exitCodePromise = new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      processClosed = true;
      clearTerminationTimers();
      child.off("close", onClose);
      reject(error);
    };
    const onClose = (code: number | null) => {
      processClosed = true;
      clearTerminationTimers();
      child.off("error", onError);
      resolve(terminationReason ? 124 : code ?? 1);
    };
    cleanupExitListeners = () => {
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.once("error", onError);
    child.once("close", onClose);
  });
  void exitCodePromise.catch(() => undefined);

  const terminateTree = (options.terminateProcessTree ?? terminateProcessTree).bind(null);
  let resolveTerminationRequest!: (pending: { promise: Promise<void> }) => void;
  const terminationRequested = new Promise<{ promise: Promise<void> }>((resolve) => {
    resolveTerminationRequest = resolve;
  });
  const requestTermination = (reason: TerminationReason): Promise<void> => {
    if (termination) return termination;
    if (processClosed) return Promise.resolve();
    terminationReason = reason;
    try {
      termination = Promise.resolve(terminateTree(child.pid ?? null, child));
    } catch (error) {
      termination = Promise.reject(error);
    }
    void termination.catch(() => undefined);
    resolveTerminationRequest({ promise: termination });
    return termination;
  };

  timeout = options.timeoutMs
    ? setTimeout(() => void requestTermination("process_timeout"), options.timeoutMs)
    : null;
  warningTimeout = options.timeoutMs && options.timeoutWarningMs && options.onTimeoutWarning
    ? setTimeout(() => {
        if (!processClosed) options.onTimeoutWarning!(child.pid ?? null);
      }, Math.max(0, options.timeoutMs - options.timeoutWarningMs))
    : null;

  let abortCleanup: (() => void) | undefined;
  if (options.signal) {
    const onAbort = () => void requestTermination("host_abort");
    if (options.signal.aborted) onAbort();
    else {
      options.signal.addEventListener("abort", onAbort, { once: true });
      abortCleanup = () => options.signal!.removeEventListener("abort", onAbort);
    }
  }

  let completed = false;
  try {
    try {
      await options.onStart?.(child.pid ?? null);
    } catch (startError) {
      let terminationError: unknown;
      try {
        await requestTermination("host_abort");
      } catch (error) {
        terminationError = error;
      }
      if (!processClosed) {
        try {
          await exitCodePromise;
        } catch {
          // The error event is also conclusive child closure evidence.
        }
      }
      throw new StreamingProcessStartError({
        pid: child.pid ?? null,
        startError,
        terminationStatus: processClosed ? "confirmed" : "unconfirmed",
        terminationEvidence: terminationError
          ? `Termination request failed before child close: ${errorMessage(terminationError)}`
          : "Child close was confirmed after the startup callback failed."
      });
    }

    const completion = await Promise.race([
      exitCodePromise.then((exitCode) => ({ type: "exit" as const, exitCode })),
      terminationRequested.then(async (pending) => {
        await pending.promise;
        return { type: "terminated" as const };
      })
    ]);
    if (termination) await termination;
    const exitCode = completion.type === "exit" ? completion.exitCode : await exitCodePromise;
    await Promise.all([stdoutDone, stderrDone]);
    completed = true;
    return {
      stdout: stdoutParts.join(""),
      stderr: stderrParts.join(""),
      exitCode,
      pid: child.pid ?? null,
      terminationReason
    };
  } finally {
    clearTerminationTimers();
    abortCleanup?.();
    cleanupExitListeners();
    cleanupStdoutListeners();
    cleanupStderrListeners();
    if (!completed) {
      stdoutReader?.close();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
