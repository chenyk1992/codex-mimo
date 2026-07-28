import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it, vi } from "vitest";
import { createHookCallbackController } from "../../src/mimo/hook-callback.js";
import { buildBridgeRuntimeEnvironment } from "../../src/mimo/runtime-config.js";
import { createJobStore, listJobs, readJob } from "../../src/core/job-store.js";
import { runJobWorker, type JobWorkerDependencies } from "../../src/core/job-worker.js";
import { planSliceManifest } from "../../src/compose/slices.js";
import { runReadOnlyDiffReview } from "../../src/compose/diff-review.js";

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

function writeCancelHookToConfigDir(configDir: string): string {
  const pluginDir = path.join(configDir, "plugin");
  const hookFile = path.join(pluginDir, "cancel.js");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    hookFile,
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
  return hookFile;
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
  it("keeps a real plan job read-only while inheriting MiMoCode model configuration", async () => {
    await withHookSmokeTempDirectories(async (root) => {
      await execa("git", ["init"], { cwd: root });
      await execa("git", ["config", "user.email", "smoke@example.com"], { cwd: root });
      await execa("git", ["config", "user.name", "Smoke Test"], { cwd: root });
      fs.writeFileSync(path.join(root, "README.md"), "# Sample\n", "utf8");
      fs.writeFileSync(path.join(root, ".gitignore"), ".codex-mimo/\n", "utf8");
      await execa("git", ["add", "README.md", ".gitignore"], { cwd: root });
      await execa("git", ["commit", "-m", "initial"], { cwd: root });

      const job = createJobStore(root).create({
        kind: "plan",
        task: "Plan a minimal change that adds one sentence to README.md. Do not edit files.",
        request: {
          cwd: root,
          task: "Plan a minimal change that adds one sentence to README.md. Do not edit files.",
          timeoutMs: 60_000
        }
      });

      await runJobWorker(root, job.id);

      expect(readJob(root, job.id)).toMatchObject({
        status: "completed",
        changedFiles: [],
        executionCallback: { outcome: "completed" }
      });
      expect(fs.existsSync(path.join(root, ".mimocode", "plans"))).toBe(false);
      expect((await execa("git", ["status", "--short"], { cwd: root })).stdout).toBe("");
    });
  }, 90_000);

  it("keeps a real Compose plan read-only under the same MiMoCode configuration", async () => {
    await withHookSmokeTempDirectories(async (root) => {
      await execa("git", ["init"], { cwd: root });
      await execa("git", ["config", "user.email", "smoke@example.com"], { cwd: root });
      await execa("git", ["config", "user.name", "Smoke Test"], { cwd: root });
      fs.writeFileSync(path.join(root, "README.md"), "# Sample\n", "utf8");
      fs.writeFileSync(path.join(root, ".gitignore"), ".codex-mimo/\n", "utf8");
      await execa("git", ["add", "README.md", ".gitignore"], { cwd: root });
      await execa("git", ["commit", "-m", "initial"], { cwd: root });

      const job = createJobStore(root).create({
        kind: "compose",
        task: "Plan a minimal change that adds one sentence to README.md.",
        request: {
          cwd: root,
          workflow: "plan",
          task: "Plan a minimal change that adds one sentence to README.md.",
          timeoutMs: 60_000
        }
      });

      await runJobWorker(root, job.id);

      expect(readJob(root, job.id)).toMatchObject({
        status: "completed",
        changedFiles: [],
        executionCallback: { outcome: "completed" }
      });
      expect(fs.existsSync(path.join(root, ".mimocode", "plans"))).toBe(false);
      expect((await execa("git", ["status", "--short"], { cwd: root })).stdout).toBe("");
    });
  }, 90_000);

  it("runs real read-only slice planning without project side effects", async () => {
    await withHookSmokeTempDirectories(async (root) => {
      await execa("git", ["init"], { cwd: root });
      await execa("git", ["config", "user.email", "smoke@example.com"], { cwd: root });
      await execa("git", ["config", "user.name", "Smoke Test"], { cwd: root });
      fs.writeFileSync(path.join(root, "README.md"), "# Sample\n", "utf8");
      fs.writeFileSync(path.join(root, ".gitignore"), ".codex-mimo/\n", "utf8");
      await execa("git", ["add", "README.md", ".gitignore"], { cwd: root });
      await execa("git", ["commit", "-m", "initial"], { cwd: root });

      const result = await planSliceManifest({
        cwd: root,
        chainId: "chain-smoke",
        objective: "Add one sentence to README.md.",
        batchMode: "auto",
        acceptance: {
          build: ["node --version"],
          test: ["node --version"],
          diffCheck: false
        },
        repositoryFingerprint: "smoke-fingerprint"
      });

      if (!result.ok) {
        throw new Error(`Real slice planning failed: ${result.reason}`);
      }
      expect(fs.existsSync(path.join(root, ".mimocode", "plans"))).toBe(false);
      expect((await execa("git", ["status", "--short"], { cwd: root })).stdout).toBe("");
    });
  }, 90_000);

  it("runs a real read-only diff review without adding review artifacts", async () => {
    await withHookSmokeTempDirectories(async (root) => {
      await execa("git", ["init"], { cwd: root });
      await execa("git", ["config", "user.email", "smoke@example.com"], { cwd: root });
      await execa("git", ["config", "user.name", "Smoke Test"], { cwd: root });
      fs.writeFileSync(path.join(root, "README.md"), "# Sample\n", "utf8");
      fs.writeFileSync(path.join(root, ".gitignore"), ".codex-mimo/\n", "utf8");
      await execa("git", ["add", "README.md", ".gitignore"], { cwd: root });
      await execa("git", ["commit", "-m", "initial"], { cwd: root });
      fs.writeFileSync(path.join(root, "README.md"), "# Sample\n\nOne extra sentence.\n", "utf8");
      const diffDir = path.join(root, ".codex-mimo", "diffs");
      const diffPath = path.join(diffDir, "smoke.diff");
      fs.mkdirSync(diffDir, { recursive: true });
      fs.writeFileSync(diffPath, (await execa("git", ["diff"], { cwd: root })).stdout, "utf8");
      const statusBefore = (await execa("git", ["status", "--short"], { cwd: root })).stdout;

      const result = await runReadOnlyDiffReview({ cwd: root, diffPath });

      expect(result.outcome).toBe("passed");
      expect(fs.existsSync(path.join(root, ".mimocode", "plans"))).toBe(false);
      expect((await execa("git", ["status", "--short"], { cwd: root })).stdout).toBe(statusBefore);
    });
  }, 90_000);

  it("loads runtime hooks through the unified background job worker", async () => {
    await withHookSmokeTempDirectories(async (root) => {
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
          timeoutMs: 60_000,
          batchMode: "single",
          allowedPaths: ["probe.txt"],
          acceptance: {
            build: ["node --version"],
            test: ["node --version"],
            diffCheck: false
          }
        }
      });

      const dependencies: JobWorkerDependencies = {
        createHookCallbackController: async (input) => {
          const hook = await createHookCallbackController({ ...input, callbackWaitMs: 15_000 });
          const cancelHook = writeCancelHookToConfigDir(hook.configDir);
          Object.assign(hook.env, buildBridgeRuntimeEnvironment(cancelHook, hook.env));
          return hook;
        }
      };

      await runJobWorker(root, job.id, dependencies);
      const child = listJobs(root).find((candidate) => candidate.parentJobId === job.id);
      expect(child).toBeTruthy();
      await runJobWorker(root, child!.id, dependencies);

      expect(readJob(root, job.id)).toMatchObject({
        status: "failed",
        errorCode: "callback_cancelled"
      });
      expect(readJob(root, child!.id)).toMatchObject({
        status: "failed",
        errorCode: "callback_cancelled",
        executionCallback: {
          outcome: "cancelled",
          error: "MiMoCode completion callback reported cancellation."
        }
      });
      expect(readJob(root, child!.id)?.executionCallback?.sessionId).toBeTruthy();
    });
  }, 60_000);
});
