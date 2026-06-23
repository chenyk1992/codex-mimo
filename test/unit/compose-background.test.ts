import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runComposeJobWorker } from "../../src/compose/job-worker.js";
import { createJobStore, readJob } from "../../src/core/job-store.js";

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-compose-worker-"));
}

describe("compose job worker", () => {
  it("runs a stored compose request and completes the job", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      workflow: "dev",
      task: "Implement login throttling",
      request: {
        cwd,
        workflow: "dev",
        task: "Implement login throttling",
        reportDir: path.join(cwd, ".codex-mimo", "reports")
      }
    });

    await runComposeJobWorker(cwd, job.id, {
      runMimoStreaming: async (_cwd, _args, options) => {
        options.onLine?.("{\"type\":\"message\",\"text\":\"done\"}");
        return {
          stdout: "{\"type\":\"message\",\"text\":\"done\"}\n",
          stderr: "",
          exitCode: 0,
          pid: 777
        };
      },
      captureDiff: async () => ({ changedFiles: [], diffStat: "", diff: "" }),
      captureStatus: async () => ({ short: "", dirty: false }),
      runVerification: async () => [],
      now: () => new Date("2026-06-23T00:00:00.000Z")
    });

    const updated = readJob(cwd, job.id);
    expect(updated.status).toBe("completed");
    expect(updated.phase).toBe("done");
    expect(updated.summary).toContain("dev passed");
    expect(updated.reportPaths?.json).toContain(".json");
  });

  it("keeps partial report paths when MiMo exits nonzero", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      workflow: "dev",
      task: "Failing task",
      request: { cwd, workflow: "dev", task: "Failing task" }
    });

    await runComposeJobWorker(cwd, job.id, {
      runMimoStreaming: async (_cwd, _args, options) => {
        options.onLine?.("{\"type\":\"message\",\"text\":\"partial\"}");
        return { stdout: "{\"type\":\"message\",\"text\":\"partial\"}\n", stderr: "boom", exitCode: 2, pid: 111 };
      },
      captureDiff: async () => ({ changedFiles: [], diffStat: "", diff: "" }),
      captureStatus: async () => ({ short: "", dirty: false }),
      runVerification: async () => [],
      now: () => new Date("2026-06-23T00:00:00.000Z")
    });

    const updated = readJob(cwd, job.id);
    expect(updated.status).toBe("failed");
    expect(updated.reportPaths?.json).toContain(".json");
    expect(fs.existsSync(updated.reportPaths!.json!)).toBe(true);
  });
});
