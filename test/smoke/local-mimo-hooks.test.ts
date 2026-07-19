import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it, vi } from "vitest";
import { createHookCallbackController } from "../../src/mimo/hook-callback.js";
import { createJobStore, readJob } from "../../src/core/job-store.js";
import { runJobWorker } from "../../src/core/job-worker.js";

const runSmoke = process.env.RUN_LOCAL_MIMO_HOOK_SMOKE === "1";
const describeSmoke = runSmoke ? describe : describe.skip;

interface HookSmokeTempDirectoryDependencies {
  createTemporaryDirectory(prefix: string): string;
  removeTemporaryDirectory(directory: string): void;
}

function removeTemporaryDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir())) {
    throw new Error(`Refusing to recursively remove non-temporary path: ${resolved}`);
  }
  fs.rmSync(resolved, {
    recursive: true,
    force: true,
    maxRetries: 50,
    retryDelay: 100
  });
}

async function withHookSmokeTempDirectories(
  run: (root: string, home: string) => Promise<void>,
  dependencies: HookSmokeTempDirectoryDependencies = {
    createTemporaryDirectory: (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    removeTemporaryDirectory
  }
): Promise<void> {
  const temporaryDirectories: string[] = [];
  try {
    const root = dependencies.createTemporaryDirectory("codex-mimo-runtime-hook-");
    temporaryDirectories.push(root);
    const home = dependencies.createTemporaryDirectory("codex-mimo-runtime-home-");
    temporaryDirectories.push(home);
    await run(root, home);
  } finally {
    let cleanupError: unknown;
    for (const directory of temporaryDirectories.reverse()) {
      try {
        dependencies.removeTemporaryDirectory(directory);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError !== undefined) throw cleanupError;
  }
}

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

describe("local MiMoCode hook smoke cleanup", () => {
  it("removes both temporary directories when setup fails", async () => {
    const root = path.join(os.tmpdir(), "codex-mimo-runtime-hook-red");
    const home = path.join(os.tmpdir(), "codex-mimo-runtime-home-red");
    const created = [root, home];
    const removeTemporaryDirectory = vi.fn();
    const setupFailure = new Error("git setup failed");

    await expect(withHookSmokeTempDirectories(
      async () => {
        throw setupFailure;
      },
      {
        createTemporaryDirectory: () => created.shift()!,
        removeTemporaryDirectory
      }
    )).rejects.toBe(setupFailure);

    expect(removeTemporaryDirectory.mock.calls).toEqual([[home], [root]]);
  });
});

describeSmoke("local MiMoCode hooks", () => {
  it("loads runtime hooks through the unified background job worker", async () => {
    await withHookSmokeTempDirectories(async (root, home) => {
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
          error: "MiMoCode completion callback reported cancellation."
        }
      });
      expect(readJob(root, job.id)?.executionCallback?.sessionId).toBeTruthy();
    });
  }, 60_000);
});
