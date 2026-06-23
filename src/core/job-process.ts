import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type WorkerKind = "compose";

export interface WorkerProcessLaunch {
  entryPoint: string;
  args: string[];
  cwd: string;
}

export function buildWorkerArgs(kind: WorkerKind, jobId: string): string[] {
  if (kind === "compose") return ["compose-worker", "--job-id", jobId];
  return [String(kind), "--job-id", jobId];
}

export function buildWorkerProcessLaunch(
  projectCwd: string,
  kind: WorkerKind,
  jobId: string,
  moduleUrl = import.meta.url
): WorkerProcessLaunch {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const distDir = path.resolve(moduleDir, "..");
  const pluginRoot = path.resolve(distDir, "..");
  const entryPoint = path.join(distDir, "cli", "main.js");

  return {
    entryPoint,
    args: [entryPoint, ...buildWorkerArgs(kind, jobId), "--cwd", projectCwd],
    cwd: pluginRoot
  };
}

export function spawnJobWorker(cwd: string, kind: WorkerKind, jobId: string): number | null {
  const launch = buildWorkerProcessLaunch(cwd, kind, jobId);
  const child = spawn(process.execPath, launch.args, {
    cwd: launch.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child.pid ?? null;
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
