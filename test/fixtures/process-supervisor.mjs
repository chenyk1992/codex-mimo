import { spawn } from "node:child_process";
import fs from "node:fs";
import { runJobSupervisor } from "../../dist/core/job-supervisor.js";

const [cwd] = process.argv.slice(2);
const jobWorker = process.env.PROCESS_JOB_WORKER_PATH;
const notifyWorker = process.env.PROCESS_NOTIFY_WORKER_PATH;
if (!cwd || !jobWorker || !notifyWorker) {
  throw new Error("cwd, PROCESS_JOB_WORKER_PATH, and PROCESS_NOTIFY_WORKER_PATH are required.");
}

await runJobSupervisor(cwd, {
  pollIntervalMs: Number(process.env.SUPERVISOR_POLL_MS ?? "25"),
  spawnJobWorker: (workerCwd, jobId) => start(jobWorker, [workerCwd, jobId]),
  spawnNotificationWorker: (workerCwd) => start(notifyWorker, [workerCwd])
});

if (process.env.SUPERVISOR_DONE_FILE) {
  fs.writeFileSync(process.env.SUPERVISOR_DONE_FILE, "done\n", "utf8");
}

function start(file, args) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child.pid ?? 0;
}
