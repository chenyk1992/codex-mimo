import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mimoCompose } from "../../src/codex/tools.js";
import { readJob } from "../../src/core/job-store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("mimo_compose", () => {
  it("rejects missing workflow-required input without creating a job", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-compose-"));
    dirs.push(cwd);
    const spawnJobSupervisor = vi.fn();

    await expect(mimoCompose({ cwd, workflow: "dev" }, { env: {}, spawnJobSupervisor }))
      .rejects.toThrow(/requires a task/i);

    expect(spawnJobSupervisor).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(cwd, ".codex-mimo"))).toBe(false);
  });

  it("stores the Compose request and returns only a queued receipt", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-compose-"));
    dirs.push(cwd);
    const spawnJobSupervisor = vi.fn().mockReturnValue(123);
    const result = await mimoCompose({
      cwd,
      workflow: "dev",
      task: "Build it",
      verification: ["npm test"]
    }, { env: {}, spawnJobSupervisor });

    expect(result).toEqual({
      jobId: expect.any(String), kind: "compose", status: "queued",
      actions: { status: "mimo_status", events: "mimo_events", result: "mimo_result", cancel: "mimo_cancel" }
    });
    expect(readJob(cwd, result.jobId)?.request).toEqual({
      cwd,
      workflow: "dev",
      task: "Build it",
      verification: ["npm test"],
      timeoutMs: 1_800_000
    });
    expect(spawnJobSupervisor).toHaveBeenCalledWith(cwd);
  });

  it("does not wait for a fake worker", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-compose-"));
    dirs.push(cwd);
    let finished = false;
    const result = await mimoCompose({ cwd, workflow: "dev", task: "Build it" }, {
      env: {},
      spawnJobSupervisor: () => {
        setTimeout(() => { finished = true; }, 50);
        return 123;
      }
    });
    expect(result.status).toBe("queued");
    expect(finished).toBe(false);
  });
});
