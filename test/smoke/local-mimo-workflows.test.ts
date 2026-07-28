import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { createJobStore, listJobs, readJob } from "../../src/core/job-store.js";
import { runJobWorker, type JobWorkerDependencies } from "../../src/core/job-worker.js";
import type { JobKind, JobRecord } from "../../src/core/jobs.js";

const runSmoke = process.env.RUN_LOCAL_MIMO_WORKFLOW_SMOKE === "1";
const describeSmoke = runSmoke ? describe : describe.skip;
const tempDirs: string[] = [];
const workerDependencies: JobWorkerDependencies = {
  chainBootstrap: { spawnJobSupervisor: () => 0 },
  chainAdvance: { spawnJobSupervisor: () => 0 }
};

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir())) {
      throw new Error(`Refusing to recursively remove non-temporary path: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

async function createProject(): Promise<string> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-workflow-"));
  tempDirs.push(cwd);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".codex-mimo/\n", "utf8");
  fs.writeFileSync(path.join(cwd, "src", "value.mjs"), "export const value = 1;\n", "utf8");
  fs.writeFileSync(
    path.join(cwd, "test", "value.test.mjs"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { value } from "../src/value.mjs";',
      'test("value is two", () => assert.equal(value, 2));',
      ""
    ].join("\n"),
    "utf8"
  );
  await execa("git", ["init"], { cwd });
  await execa("git", ["config", "user.email", "smoke@example.com"], { cwd });
  await execa("git", ["config", "user.name", "Smoke Test"], { cwd });
  await execa("git", ["add", "."], { cwd });
  await execa("git", ["commit", "-m", "initial"], { cwd });
  return cwd;
}

async function runRootAndChildren(cwd: string, rootId: string): Promise<JobRecord> {
  await runJobWorker(cwd, rootId, workerDependencies);
  while (true) {
    const child = listJobs(cwd).find(
      (job) => job.parentJobId === rootId && job.status === "queued"
    );
    if (!child) break;
    await runJobWorker(cwd, child.id, workerDependencies);
  }
  const root = readJob(cwd, rootId);
  if (!root) throw new Error(`Missing root job ${rootId}`);
  return root;
}

function createJob(
  cwd: string,
  kind: JobKind,
  task: string,
  request: unknown
): JobRecord {
  return createJobStore(cwd).create({ kind, task, request });
}

function diagnosticJobs(cwd: string): unknown {
  return listJobs(cwd).map((entry) => ({
    id: entry.id,
    parentJobId: entry.parentJobId,
    status: entry.status,
    errorCode: entry.errorCode,
    error: entry.error,
    summary: entry.summary,
    executionCallback: entry.executionCallback,
    acceptance: entry.acceptance,
    logTail: readTail(entry.logFile),
    eventsTail: readTail(entry.eventsFile)
  }));
}

function readTail(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-12)
    .map((line) => line.slice(0, 1_000));
}

describeSmoke("local MiMoCode workflow smoke", () => {
  it("completes a bounded implementation with real build and test acceptance", async () => {
    const cwd = await createProject();
    const job = createJob(cwd, "implement", "Change the exported value from 1 to 2.", {
      cwd,
      task: "Edit only src/value.mjs so it exports value = 2. Do not change tests.",
      allowWrite: true,
      timeoutMs: 60_000,
      batchMode: "single",
      allowedPaths: ["src/value.mjs"],
      acceptance: {
        build: ["node --check src/value.mjs"],
        test: ["node --test test/value.test.mjs"],
        diffCheck: false
      }
    });

    const result = await runRootAndChildren(cwd, job.id);

    if (result.status !== "completed") {
      throw new Error(JSON.stringify(diagnosticJobs(cwd), null, 2));
    }
    expect(result).toMatchObject({
      status: "completed",
      acceptance: {
        stages: [
          { stage: "build", outcome: "passed" },
          { stage: "test", outcome: "passed" }
        ]
      }
    });
    expect(fs.readFileSync(path.join(cwd, "src", "value.mjs"), "utf8")).toContain("value = 2");
    expect(result.changedFiles).toEqual(["src/value.mjs"]);
  }, 140_000);

  it("completes a direct review without changing the existing diff", async () => {
    const cwd = await createProject();
    fs.writeFileSync(path.join(cwd, "src", "value.mjs"), "export const value = 2;\n", "utf8");
    const statusBefore = (await execa("git", ["status", "--short"], { cwd })).stdout;
    const job = createJob(cwd, "review", "Review current diff", {
      cwd,
      base: "HEAD",
      timeoutMs: 90_000
    });

    await runJobWorker(cwd, job.id, workerDependencies);
    const result = readJob(cwd, job.id);

    expect(result).toMatchObject({
      status: "completed",
      changedFiles: [],
      executionCallback: { outcome: "completed" }
    });
    expect((await execa("git", ["status", "--short"], { cwd })).stdout).toBe(statusBefore);
    expect(fs.existsSync(path.join(cwd, ".mimocode", "plans"))).toBe(false);
  }, 150_000);

  it("repairs a focused CI failure from an attached log", async () => {
    const cwd = await createProject();
    const testFile = fs.readFileSync(path.join(cwd, "test", "value.test.mjs"), "utf8");
    fs.writeFileSync(
      path.join(cwd, "ci.log"),
      "AssertionError: Expected 2 but received 1 in test/value.test.mjs\n",
      "utf8"
    );
    const job = createJob(cwd, "fix-ci", "Fix the CI failure", {
      cwd,
      file: "ci.log",
      task: "Fix only src/value.mjs so the existing test passes. Do not edit the test.",
      timeoutMs: 90_000
    });

    await runJobWorker(cwd, job.id, workerDependencies);
    const result = readJob(cwd, job.id);

    expect(result).toMatchObject({
      status: "completed",
      executionCallback: { outcome: "completed" }
    });
    expect(fs.readFileSync(path.join(cwd, "src", "value.mjs"), "utf8")).toContain("value = 2");
    expect(fs.readFileSync(path.join(cwd, "test", "value.test.mjs"), "utf8")).toBe(testFile);
  }, 150_000);

  it("completes a bounded Compose dev workflow with host acceptance", async () => {
    const cwd = await createProject();
    const job = createJob(cwd, "compose", "Change the exported value from 1 to 2.", {
      cwd,
      workflow: "dev",
      task: "Edit only src/value.mjs so it exports value = 2. Do not change tests.",
      timeoutMs: 120_000,
      batchMode: "single",
      allowedPaths: ["src/value.mjs"],
      acceptance: {
        build: ["node --check src/value.mjs"],
        test: ["node --test test/value.test.mjs"],
        diffCheck: false
      }
    });

    const result = await runRootAndChildren(cwd, job.id);

    if (result.status !== "completed") {
      throw new Error(JSON.stringify(diagnosticJobs(cwd), null, 2));
    }
    expect(result).toMatchObject({
      status: "completed",
      acceptance: {
        stages: [
          { stage: "build", outcome: "passed" },
          { stage: "test", outcome: "passed" }
        ]
      }
    });
    expect(fs.readFileSync(path.join(cwd, "src", "value.mjs"), "utf8")).toContain("value = 2");
    expect(result.changedFiles).toEqual(["src/value.mjs"]);
  }, 210_000);

  it("resumes a real read-only session without changing the workspace", async () => {
    const cwd = await createProject();
    const plan = createJob(cwd, "plan", "Plan a one-line value change.", {
      cwd,
      task: "Plan changing src/value.mjs from value 1 to value 2. Do not edit files.",
      timeoutMs: 90_000
    });
    await runJobWorker(cwd, plan.id, workerDependencies);
    const parent = readJob(cwd, plan.id);
    expect(parent).toMatchObject({
      status: "completed",
      executionCallback: { outcome: "completed" }
    });
    expect(parent?.sessionId).toBeTruthy();

    const resume = createJob(cwd, "resume", "Continue the plan", {
      cwd,
      jobId: plan.id,
      task: "Add one concise verification note to the plan. Do not edit files.",
      sessionId: parent!.sessionId!,
      executionPolicy: {
        agent: "codex-mimo-readonly",
        writesAllowed: false
      },
      timeoutMs: 90_000
    });
    await runJobWorker(cwd, resume.id, workerDependencies);
    const result = readJob(cwd, resume.id);

    expect(result).toMatchObject({
      status: "completed",
      changedFiles: [],
      executionCallback: { outcome: "completed" }
    });
    expect((await execa("git", ["status", "--short"], { cwd })).stdout).toBe("");
  }, 210_000);

  it("blocks a real out-of-scope write and fails the chain safely", async () => {
    const cwd = await createProject();
    const job = createJob(cwd, "implement", "Exercise write-scope enforcement.", {
      cwd,
      task: [
        "First edit src/value.mjs so it exports value = 2.",
        "Then create forbidden.mjs with any content.",
        "Both steps are required."
      ].join(" "),
      allowWrite: true,
      timeoutMs: 90_000,
      batchMode: "single",
      allowedPaths: ["src/value.mjs"],
      acceptance: {
        build: ["node --check src/value.mjs"],
        test: ["node --test test/value.test.mjs"],
        diffCheck: false
      }
    });

    const result = await runRootAndChildren(cwd, job.id);

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "write_scope_violation"
    });
    expect(result.failureCauses).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "write_scope_violation", stage: "scope_check" })
    ]));
  }, 180_000);
});
