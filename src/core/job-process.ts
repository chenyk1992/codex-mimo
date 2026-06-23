import { spawn } from "node:child_process";

export type WorkerKind = "compose";

export function buildWorkerArgs(kind: WorkerKind, jobId: string): string[] {
  if (kind === "compose") return ["compose-worker", "--job-id", jobId];
  return [String(kind), "--job-id", jobId];
}

export function spawnJobWorker(cwd: string, kind: WorkerKind, jobId: string): number | null {
  const child = spawn(process.execPath, ["dist/cli/main.js", ...buildWorkerArgs(kind, jobId)], {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child.pid ?? null;
}

export function terminateJobProcess(
  pid: number | null | undefined,
  options: { killProcess?: (pid: number) => void } = {}
): void {
  if (!Number.isFinite(pid)) return;
  const killProcess = options.killProcess ?? ((targetPid: number) => process.kill(targetPid));
  try {
    killProcess(pid as number);
  } catch {
    // Best-effort cancellation. The job state is still updated by the caller.
  }
}
