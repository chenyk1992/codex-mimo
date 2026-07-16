import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runJobWorker } from "../../../src/core/job-worker.js";
import { createJobStore, readJob } from "../../../src/core/job-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const cwd of tempDirs.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

describe("error propagation", () => {
  it("unified worker persists a meaningful MiMoCode startup failure", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-xcut-err-"));
    tempDirs.push(cwd);
    const job = createJobStore(cwd).create({
      kind: "implement",
      task: "Test ENOENT",
      request: { cwd, task: "Test ENOENT", allowWrite: true }
    });
    const enoent = new Error("spawn mimo ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";

    await runJobWorker(cwd, job.id, {
      captureStatus: async () => ({ short: "", dirty: false, fingerprints: {} }),
      captureHead: async () => ({ oid: "abc", short: "abc", subject: "base" }),
      createHookCallbackController: async () => ({
        invocationId: "worker-error",
        token: "token",
        endpoint: "http://127.0.0.1:1/mimo-hook",
        configDir: "hook-dir",
        callbackFile: "callback.json",
        env: {},
        waitForCallback: async () => null,
        close: async () => undefined
      }),
      runMimoStreaming: async () => { throw enoent; }
    });

    expect(readJob(cwd, job.id)).toMatchObject({
      status: "failed",
      errorCode: "mimo_run_failed",
      pid: null
    });
    expect(readJob(cwd, job.id)?.error).toContain("spawn mimo ENOENT");
  });
});
