import { spawn } from "node:child_process";
import fs from "node:fs";
import { runJobWorker } from "../../dist/core/job-worker.js";
import { createHookCallbackController } from "../../dist/mimo/hook-callback.js";
import { runMimoCliStreaming } from "../../dist/mimo/streaming-runner.js";

const [cwd, jobId] = process.argv.slice(2);
const fakeMimo = process.env.FAKE_MIMO_PATH;
if (!cwd || !jobId || !fakeMimo) throw new Error("cwd, jobId, and FAKE_MIMO_PATH are required.");

if (process.env.JOB_WORKER_PID_FILE) {
  fs.writeFileSync(process.env.JOB_WORKER_PID_FILE, `${process.pid}\n`, "utf8");
}

await runJobWorker(cwd, jobId, {
  bootstrapWriteJobChain: async () => ({ status: "skipped" }),
  createHookCallbackController: (input) => createHookCallbackController({
    ...input,
    callbackWaitMs: 100
  }),
  spawnNotificationWorker: () => 999,
  runMimoStreaming: (spawnCwd, args, options) => runMimoCliStreaming(spawnCwd, args, {
    ...options,
    env: {
      ...options.env,
      FAKE_MIMO_MODE: "hang",
      FAKE_MIMO_CALLBACK: "0",
      FAKE_MIMO_TREE: "1",
      FAKE_MIMO_CHECKPOINT_FILE: process.env.FAKE_MIMO_CHECKPOINT_FILE,
      FAKE_MIMO_INVOCATIONS_FILE: process.env.FAKE_MIMO_INVOCATIONS_FILE
    },
    spawnProcess: (childCwd, _mimoArgs, env) => spawn(process.execPath, [fakeMimo], {
      cwd: childCwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    })
  })
});

if (process.env.JOB_WORKER_DONE_FILE) {
  fs.writeFileSync(process.env.JOB_WORKER_DONE_FILE, "done\n", "utf8");
}
