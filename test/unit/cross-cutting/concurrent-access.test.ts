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
  mutateJobAuthoritative,
  readJob,
  updateJob
} from "../../../src/core/job-store.js";
import {
  claimDueDelivery,
  enqueueDelivery,
  readDeliveries
} from "../../../src/notify/outbox.js";
import { readJobSignals } from "../../../src/core/job-signals.js";
import { appendJobProgress, transitionJob, updateRunningJobProcess } from "../../../src/core/job-transition.js";

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

    const updated1 = updateJob(cwd, job.id, {
      status: "running", phase: "starting", pid: 100, processIdentity: "start-100"
    });
    const updated2 = updateJob(cwd, job.id, {
      status: "running", phase: "editing", pid: 200, processIdentity: "start-200"
    });

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

  it("keeps both authoritative records across cross-process create/create", async () => {
    const cwd = tempWorkspace();
    const storeModule = pathToFileURL(path.resolve("src/core/job-store.ts")).href;
    const script = `
      import { createJobStore } from ${JSON.stringify(storeModule)};
      const delay = Number(process.argv[2]) - Date.now();
      if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      const job = createJobStore(process.argv[3]).create({
        kind: "implement", task: process.argv[4], request: { cwd: process.argv[3] }
      });
      process.stdout.write(job.id);
    `;
    const childScript = path.join(cwd, "create-child.ts");
    fs.writeFileSync(childScript, script, "utf8");
    const viteNode = path.resolve("node_modules/vite-node/vite-node.mjs");
    const startAt = Date.now() + 300;
    const create = (task: string) => execFileAsync(process.execPath, [
      viteNode, childScript, String(startAt), cwd, task
    ]);

    const outputs = await Promise.all([create("first"), create("second")]);
    const ids = outputs.map(({ stdout }) => stdout.trim());

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => readJob(cwd, id) !== undefined)).toBe(true);
    expect(listJobs(cwd).map((job) => job.id)).toEqual(expect.arrayContaining(ids));
  });

  it("keeps create and update records across processes without a stale cache orphan", async () => {
    const cwd = tempWorkspace();
    const existing = createJobStore(cwd).create({
      kind: "implement",
      task: "existing",
      request: { cwd }
    });
    const storeModule = pathToFileURL(path.resolve("src/core/job-store.ts")).href;
    const script = `
      import { createJobStore, updateJob } from ${JSON.stringify(storeModule)};
      const delay = Number(process.argv[2]) - Date.now();
      if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      if (process.argv[4] === "create") {
        const job = createJobStore(process.argv[3]).create({
          kind: "implement", task: "new", request: { cwd: process.argv[3] }
        });
        process.stdout.write(job.id);
      } else {
        const job = updateJob(process.argv[3], process.argv[5], { summary: "updated" });
        process.stdout.write(job.id);
      }
    `;
    const childScript = path.join(cwd, "create-update-child.ts");
    fs.writeFileSync(childScript, script, "utf8");
    const viteNode = path.resolve("node_modules/vite-node/vite-node.mjs");
    const startAt = Date.now() + 300;
    const run = (mode: "create" | "update") => execFileAsync(process.execPath, [
      viteNode, childScript, String(startAt), cwd, mode, existing.id
    ]);

    const [created] = await Promise.all([run("create"), run("update")]);
    const createdId = created.stdout.trim();

    expect(readJob(cwd, existing.id)?.summary).toBe("updated");
    expect(readJob(cwd, createdId)).toBeDefined();
    expect(listJobs(cwd).map((job) => job.id)).toEqual(
      expect.arrayContaining([existing.id, createdId])
    );
  });

  it("merges dependent authoritative mutations across processes without a lost update", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "implement",
      task: "aggregate child files",
      request: { cwd }
    });
    const storeModule = pathToFileURL(path.resolve("src/core/job-store.ts")).href;
    const script = `
      import { mutateJobAuthoritative } from ${JSON.stringify(storeModule)};
      const delay = Number(process.argv[2]) - Date.now();
      if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const updated = await mutateJobAuthoritative(process.argv[3], process.argv[4], async (existing) => {
        await sleep(80);
        return { changedFiles: [...existing.changedFiles, process.argv[5]] };
      });
      process.stdout.write(JSON.stringify(updated.changedFiles));
    `;
    const childScript = path.join(cwd, "mutate-child.ts");
    fs.writeFileSync(childScript, script, "utf8");
    const viteNode = path.resolve("node_modules/vite-node/vite-node.mjs");
    const startAt = Date.now() + 300;
    const mutate = (changedFile: string) => execFileAsync(process.execPath, [
      viteNode, childScript, String(startAt), cwd, job.id, changedFile
    ]);

    await Promise.all([mutate("src/first.ts"), mutate("src/second.ts")]);

    expect(readJob(cwd, job.id)?.changedFiles.sort()).toEqual([
      "src/first.ts",
      "src/second.ts"
    ]);
  });

  it("only one concurrent claimant receives a delivery", async () => {
    const cwd = tempWorkspace();
    const file = path.join(cwd, ".codex-mimo", "jobs", "notifications.jsonl");
    await enqueueDelivery(file, {
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
      const claim = await claimDueDelivery(process.argv[3], new Date(process.argv[4]), 30_000);
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
    updateJob(cwd, job.id, {
      status: "running", phase: "editing", pid: 100, processIdentity: "start-100"
    });

    const transitionModule = pathToFileURL(path.resolve("src/core/job-transition.ts")).href;
    const script = `
      import { transitionJob } from ${JSON.stringify(transitionModule)};
      const delay = Number(process.argv[2]) - Date.now();
      if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      try {
        const result = await transitionJob(process.argv[3], process.argv[4], {
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
    const transitions = [runTransition("completed"), runTransition("failed")];
    const outputs = await Promise.all(transitions);
    const outcomes = outputs.map(({ stdout }) => JSON.parse(stdout) as {
      status?: string;
      error?: string;
    });

    const stored = readJob(cwd, job.id)!;
    const signals = readJobSignals(job.signalsFile).signals;
    const deliveries = readDeliveries(job.notificationOutboxFile);
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
    updateJob(cwd, job.id, {
      status: "running", phase: "editing", pid: 100, processIdentity: "start-100"
    });

    const transitionModule = pathToFileURL(path.resolve("src/core/job-transition.ts")).href;
    const script = `
      import { appendJobProgress } from ${JSON.stringify(transitionModule)};
      const delay = Number(process.argv[2]) - Date.now();
      if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      const signal = await appendJobProgress(process.argv[3], process.argv[4], {
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
    const progress = [runProgress("first"), runProgress("second")];
    await Promise.all(progress);

    expect(readJobSignals(job.signalsFile).signals.map((signal) => signal.cursor).sort())
      .toEqual([1, 2]);
  });

  it("keeps every job in the shared state index during different-job PID and progress updates", async () => {
    const cwd = tempWorkspace();
    const first = createJobStore(cwd).create({ kind: "implement", task: "first", request: { cwd } });
    const second = createJobStore(cwd).create({ kind: "implement", task: "second", request: { cwd } });
    await transitionJob(cwd, first.id, { status: "running", phase: "starting", summary: "first" });
    await transitionJob(cwd, second.id, { status: "running", phase: "starting", summary: "second" });

    await Promise.all([
      updateRunningJobProcess(cwd, first.id, 111, "start-111"),
      appendJobProgress(cwd, second.id, {
        kind: "milestone",
        level: "info",
        summary: "second progressed"
      })
    ]);

    expect(listJobs(cwd).map((job) => job.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(readJob(cwd, first.id)?.pid).toBe(111);
    expect(readJobSignals(second.signalsFile).signals).toEqual([
      expect.objectContaining({ kind: "phase_changed" }),
      expect.objectContaining({ kind: "milestone", summary: "MiMoCode reported progress." })
    ]);
  });
});
