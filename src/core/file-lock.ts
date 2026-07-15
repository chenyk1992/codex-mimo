import fs from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_MS = 10;
const DEFAULT_STALE_MS = 30_000;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export interface FileLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  staleMs?: number;
}

export function withFileLock<T>(
  lockFile: string,
  action: () => T,
  options: FileLockOptions = {}
): T {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  let descriptor: number;
  while (true) {
    try {
      descriptor = fs.openSync(lockFile, "wx");
      try {
        fs.writeFileSync(
          descriptor,
          JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
          "utf8"
        );
      } catch (error) {
        releaseLock(lockFile, descriptor);
        throw error;
      }
      break;
    } catch (error) {
      if (!isFileExistsError(error) || Date.now() >= deadline) throw error;
      removeStaleLock(lockFile, staleMs);
      Atomics.wait(lockWaitArray, 0, 0, retryMs);
    }
  }

  try {
    return action();
  } finally {
    releaseLock(lockFile, descriptor);
  }
}

function releaseLock(lockFile: string, descriptor: number): void {
  try {
    fs.closeSync(descriptor);
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

function removeStaleLock(lockFile: string, staleMs: number): void {
  let raw: string;
  let modifiedAt: number;
  try {
    raw = fs.readFileSync(lockFile, "utf8");
    modifiedAt = fs.statSync(lockFile).mtimeMs;
  } catch {
    return;
  }

  let pid: number | undefined;
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      pid = parsed.pid;
    }
  } catch {
    // A newly-created lock can briefly be empty; age handles abandoned malformed locks.
  }

  if (
    (pid !== undefined && !isProcessAlive(pid)) ||
    (pid === undefined && Date.now() - modifiedAt >= staleMs)
  ) {
    fs.rmSync(lockFile, { force: true });
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorWithCode(error, "ESRCH");
  }
}

function isFileExistsError(error: unknown): boolean {
  return isErrorWithCode(error, "EEXIST");
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
