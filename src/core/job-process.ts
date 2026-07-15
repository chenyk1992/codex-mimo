import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withUtf8ProcessEnv } from "./encoding.js";

export type WorkerCommand = "job-worker" | "notify-worker";

export function resolveCliEntrypoint(moduleUrl = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "cli", "main.js");
}

export function spawnWorker(command: WorkerCommand, cwd: string, jobId?: string): number {
  const args = [resolveCliEntrypoint(), command, "--cwd", cwd];
  if (jobId) args.push("--job-id", jobId);
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: withUtf8ProcessEnv()
  });
  child.unref();
  return child.pid ?? 0;
}

export function spawnJobWorker(cwd: string, jobId: string): number {
  return spawnWorker("job-worker", cwd, jobId);
}

export function spawnNotificationWorker(cwd: string): number {
  return spawnWorker("notify-worker", cwd);
}

export function terminateJobProcess(
  pid: number | null | undefined,
  options: {
    killProcess?: (pid: number) => void;
    platform?: NodeJS.Platform;
    spawnSync?: typeof spawnSync;
  } = {}
): void {
  if (!Number.isFinite(pid)) return;
  const platform = options.platform ?? process.platform;
  const killProcess = options.killProcess ?? ((targetPid: number) => process.kill(targetPid));
  try {
    if (!options.platform && options.killProcess) {
      killProcess(pid as number);
      return;
    }

    if (platform === "win32") {
      (options.spawnSync ?? spawnSync)("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      return;
    }

    try {
      killProcess(-(pid as number));
      return;
    } catch {
      killProcess(pid as number);
    }
  } catch {
    // Best-effort cancellation. The job state is still updated by the caller.
  }
}
