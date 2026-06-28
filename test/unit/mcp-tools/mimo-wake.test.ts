import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mimoWake } from "../../../src/codex/tools.js";
import { createJobStore, updateJob } from "../../../src/core/job-store.js";

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-wake-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("mimo_wake", () => {
  it("returns a Codex heartbeat wake hint for an active job", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
    updateJob(cwd, job.id, { status: "running", phase: "editing", pid: 100 });

    const result = await mimoWake({ cwd, jobId: job.id, sinceCursor: 3, minLevel: "info" });

    expect(result).toMatchObject({
      kind: "codex_heartbeat",
      jobId: job.id,
      status: "running",
      phase: "editing",
      watch: {
        tool: "mimo_wait",
        arguments: {
          cwd,
          jobId: job.id,
          sinceCursor: 3,
          minLevel: "info"
        }
      }
    });
    expect(result.prompt).toContain(job.id);
    expect(result.prompt).toContain("mimo_result");
    expect(result.heartbeat).toMatchObject({
      tool: "automation_update",
      arguments: {
        mode: "create",
        kind: "heartbeat",
        destination: "thread",
        name: `MiMoCode job ${job.id}`,
        status: "ACTIVE"
      }
    });
    expect(result.heartbeat?.arguments.prompt).toBe(result.prompt);
  });

  it("defaults to the most recent job", async () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    store.create({ kind: "compose", task: "First", request: {} });
    const job = store.create({ kind: "compose", task: "Second", request: {} });

    const result = await mimoWake({ cwd });

    expect(result.jobId).toBe(job.id);
  });

  it("returns a result hint instead of a heartbeat draft for a finished job", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run review", request: {} });
    updateJob(cwd, job.id, { status: "completed", phase: "done", summary: "Review complete." });

    const result = await mimoWake({ cwd, jobId: job.id });

    expect(result).not.toHaveProperty("heartbeat");
    expect(result).toMatchObject({
      kind: "codex_heartbeat",
      jobId: job.id,
      status: "completed",
      phase: "done",
      result: {
        tool: "mimo_result",
        arguments: {
          cwd,
          jobId: job.id
        }
      }
    });
    expect(result.prompt).toContain("already completed");
  });
});
