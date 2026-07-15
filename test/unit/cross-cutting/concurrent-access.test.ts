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
import { readJobSignals } from "../../../src/core/job-signals.js";

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
      const delay = Number(process.argv[2]) - Date.now();
      if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      const claim = claimDueDelivery(process.argv[3], new Date(process.argv[4]), 30_000);
      process.stdout.write(JSON.stringify(claim ?? null));
    `;
    const childScript = path.join(cwd, "claim-child.ts");
    fs.writeFileSync(childScript, claimScript, "utf8");
    const viteNode = path.resolve("node_modules/vite-node/vite-node.mjs");
    const startAt = Date.now() + 250;
    const runClaim = () => execFileAsync(process.execPath, [
      viteNode,
      childScript,
      String(startAt),
      file,
      "2026-07-16T00:00:00.000Z"
    ]);
    const outputs = await Promise.all([runClaim(), runClaim()]);
    const claims = outputs.map(({ stdout }) => JSON.parse(stdout) as unknown);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(readDeliveries(file)).toHaveLength(1);
  });

  it("serializes concurrent terminal transitions across processes", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      task: "Shared terminal transition",
      request: {},
      notificationTarget: { type: "codex", threadId: "thread-1" }
    });
    updateJob(cwd, job.id, { status: "running", phase: "editing", pid: 100 });

    const transitionModule = pathToFileURL(path.resolve("src/core/job-transition.ts")).href;
    const script = `
      import { transitionJob } from ${JSON.stringify(transitionModule)};
      const delay = Number(process.argv[2]) - Date.now();
      if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      try {
        const result = transitionJob(process.argv[3], process.argv[4], {
          status: process.argv[5], summary: process.argv[5]
        });
        process.stdout.write(JSON.stringify({ status: result.job.status }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    `;
    const childScript = path.join(cwd, "terminal-transition-child.ts");
    fs.writeFileSync(childScript, script, "utf8");
    const startAt = Date.now() + 300;
    const viteNode = path.resolve("node_modules/vite-node/vite-node.mjs");
    const runTransition = (status: "completed" | "failed") => execFileAsync(process.execPath, [
      viteNode,
      childScript,
      String(startAt),
      cwd,
      job.id,
      status
    ]);
    const jobLock = path.join(path.dirname(job.logFile), `${job.id}.state.lock`);
    fs.writeFileSync(jobLock, "held", "utf8");
    let settledWhileLocked = 0;
    const transitions = [runTransition("completed"), runTransition("failed")]
      .map((promise) => promise.finally(() => { settledWhileLocked += 1; }));
    await new Promise((resolve) => setTimeout(resolve, 650));
    const observedSettled = settledWhileLocked;
    fs.rmSync(jobLock, { force: true });
    const outputs = await Promise.all(transitions);
    const outcomes = outputs.map(({ stdout }) => JSON.parse(stdout) as {
      status?: string;
      error?: string;
    });

    const stored = readJob(cwd, job.id)!;
    const signals = readJobSignals(job.signalsFile).signals;
    const deliveries = readDeliveries(job.notificationOutboxFile);
    expect(observedSettled).toBe(0);
    expect(outcomes.filter((outcome) => outcome.status !== undefined)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.error !== undefined)).toHaveLength(1);
    expect(["completed", "failed"]).toContain(stored.status);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ cursor: 1, status: stored.status, kind: stored.status });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].signalCursor).toBe(signals[0].cursor);
  });

  it("allocates unique progress cursors across processes", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      task: "Shared progress",
      request: {}
    });
    updateJob(cwd, job.id, { status: "running", phase: "editing", pid: 100 });

    const transitionModule = pathToFileURL(path.resolve("src/core/job-transition.ts")).href;
    const script = `
      import { appendJobProgress } from ${JSON.stringify(transitionModule)};
      const delay = Number(process.argv[2]) - Date.now();
      if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      const signal = appendJobProgress(process.argv[3], process.argv[4], {
        kind: "milestone", level: "info", summary: process.argv[5]
      });
      process.stdout.write(JSON.stringify(signal));
    `;
    const childScript = path.join(cwd, "progress-child.ts");
    fs.writeFileSync(childScript, script, "utf8");
    const startAt = Date.now() + 300;
    const viteNode = path.resolve("node_modules/vite-node/vite-node.mjs");
    const runProgress = (summary: string) => execFileAsync(process.execPath, [
      viteNode,
      childScript,
      String(startAt),
      cwd,
      job.id,
      summary
    ]);
    const jobLock = path.join(path.dirname(job.logFile), `${job.id}.state.lock`);
    fs.writeFileSync(jobLock, "held", "utf8");
    let settledWhileLocked = 0;
    const progress = [runProgress("first"), runProgress("second")]
      .map((promise) => promise.finally(() => { settledWhileLocked += 1; }));
    await new Promise((resolve) => setTimeout(resolve, 650));
    const observedSettled = settledWhileLocked;
    fs.rmSync(jobLock, { force: true });
    await Promise.all(progress);

    expect(observedSettled).toBe(0);
    expect(readJobSignals(job.signalsFile).signals.map((signal) => signal.cursor).sort())
      .toEqual([1, 2]);
  });
});
