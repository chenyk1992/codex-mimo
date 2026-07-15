import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createJobStore,
  listJobs,
  readJob,
  updateJob
} from "../../../src/core/job-store.js";
import {
  claimDueDelivery,
  enqueueDelivery,
  readDeliveries
} from "../../../src/notify/outbox.js";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-xcut-conc-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("concurrent access", () => {
  it("two compose creates write to state.json without corruption", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);

    const job1 = store.create({ kind: "compose", workflow: "dev", task: "Task 1", request: {} });
    const job2 = store.create({ kind: "compose", workflow: "dev", task: "Task 2", request: {} });

    const jobs = listJobs(cwd);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.id)).toContain(job1.id);
    expect(jobs.map((j) => j.id)).toContain(job2.id);
  });

  it("concurrent updateJob uses last-write-wins", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({ kind: "compose", workflow: "dev", task: "Shared", request: {} });

    const updated1 = updateJob(cwd, job.id, { status: "running", phase: "starting", pid: 100 });
    const updated2 = updateJob(cwd, job.id, { status: "running", phase: "editing", pid: 200 });

    const stored = readJob(cwd, job.id);
    expect(stored?.phase).toBe("editing");
    expect(stored?.pid).toBe(200);
    expect(updated2.updatedAt >= updated1.updatedAt).toBe(true);
  });

  it("listJobs + createJob concurrent does not lose jobs", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);

    store.create({ kind: "compose", workflow: "dev", task: "First", request: {} });
    const midList = listJobs(cwd);
    store.create({ kind: "compose", workflow: "dev", task: "Second", request: {} });
    store.create({ kind: "compose", workflow: "dev", task: "Third", request: {} });
    const finalList = listJobs(cwd);

    expect(midList).toHaveLength(1);
    expect(finalList).toHaveLength(3);
  });

  it("only one concurrent claimant receives a delivery", async () => {
    const cwd = tempWorkspace();
    const file = path.join(cwd, ".codex-mimo", "jobs", "notifications.jsonl");
    enqueueDelivery(file, {
      jobId: "implement-1",
      signalCursor: 1,
      target: { type: "codex", threadId: "thread-1" },
      createdAt: "2026-07-16T00:00:00.000Z"
    });

    const outboxModule = pathToFileURL(path.resolve("src/notify/outbox.ts")).href;
    const claimScript = `
      import { claimDueDelivery } from ${JSON.stringify(outboxModule)};
      const delay = Number(process.argv[1]) - Date.now();
      if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      const claim = claimDueDelivery(process.argv[2], new Date(process.argv[3]), 30_000);
      process.stdout.write(JSON.stringify(claim ?? null));
    `;
    const startAt = Date.now() + 250;
    const runClaim = () => execFileAsync(process.execPath, [
      "--no-warnings",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      claimScript,
      String(startAt),
      file,
      "2026-07-16T00:00:00.000Z"
    ]);
    const outputs = await Promise.all([runClaim(), runClaim()]);
    const claims = outputs.map(({ stdout }) => JSON.parse(stdout) as unknown);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(readDeliveries(file)).toHaveLength(1);
  });
});
