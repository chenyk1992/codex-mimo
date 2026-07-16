import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { createHookCallbackController } from "../../src/mimo/hook-callback.js";
import { createJobStore, readJob } from "../../src/core/job-store.js";
import { runJobWorker } from "../../src/core/job-worker.js";

const runSmoke = process.env.RUN_LOCAL_MIMO_HOOK_SMOKE === "1";
const describeSmoke = runSmoke ? describe : describe.skip;

function writeCancelHookToConfigDir(configDir: string): void {
  const pluginDir = path.join(configDir, "plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "cancel.js"),
    `
export default async () => ({
  "session.pre": async (_input, output) => {
    output.cancel = true;
    output.cancelReason = "local smoke";
  }
});
`,
    "utf-8"
  );
}

describeSmoke("local MiMoCode hooks", () => {
  it("loads runtime hooks through the unified background job worker", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-runtime-hook-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-runtime-home-"));
    await execa("git", ["init"], { cwd: root });
    await execa("git", ["config", "user.email", "smoke@example.com"], { cwd: root });
    await execa("git", ["config", "user.name", "Smoke Test"], { cwd: root });
    fs.writeFileSync(path.join(root, "README.md"), "hook smoke\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: root });
    await execa("git", ["commit", "-m", "initial"], { cwd: root });
    const job = createJobStore(root).create({
      kind: "implement",
      task: "local runtime hook smoke",
      request: {
        cwd: root,
        task: "local runtime hook smoke",
        allowWrite: true,
        timeoutMs: 60_000
      }
    });

    await runJobWorker(root, job.id, {
      createHookCallbackController: async (input) => {
        const hook = await createHookCallbackController({ ...input, callbackWaitMs: 15_000 });
        writeCancelHookToConfigDir(hook.configDir);
        hook.env.MIMOCODE_HOME = home;
        return hook;
      }
    });

    expect(readJob(root, job.id)).toMatchObject({
      status: "failed",
      errorCode: "callback_cancelled",
      executionCallback: {
        outcome: "cancelled",
        error: "local smoke"
      }
    });
    expect(readJob(root, job.id)?.executionCallback?.sessionId).toBeTruthy();
  }, 60_000);
});
