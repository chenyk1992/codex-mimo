import fs from "node:fs";

const WINDOWS_RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40] as const;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

export interface RenameWithWindowsRetryDependencies {
  platform?: NodeJS.Platform;
  renameSync?: typeof fs.renameSync;
  sleepSync?: (milliseconds: number) => void;
}

export function renameWithWindowsRetry(
  source: fs.PathLike,
  target: fs.PathLike,
  dependencies: RenameWithWindowsRetryDependencies = {}
): void {
  const platform = dependencies.platform ?? process.platform;
  const rename = dependencies.renameSync ?? fs.renameSync;
  const sleep = dependencies.sleepSync ?? sleepSync;

  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(source, target);
      return;
    } catch (error) {
      if (!isTransientWindowsRenameError(error, platform) ||
          attempt >= WINDOWS_RENAME_RETRY_DELAYS_MS.length) {
        throw error;
      }
      sleep(WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function isTransientWindowsRenameError(error: unknown, platform: NodeJS.Platform): boolean {
  if (platform !== "win32" || typeof error !== "object" || error === null) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(sleepBuffer, 0, 0, milliseconds);
}
