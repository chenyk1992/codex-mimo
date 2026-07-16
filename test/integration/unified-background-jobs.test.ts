import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobRequestByKind } from "../../src/core/job-definitions.js";
import { launchJob } from "../../src/core/job-launcher.js";
import { runJobWorker, type JobWorkerDependencies } from "../../src/core/job-worker.js";
import { createJobStore, readJob } from "../../src/core/job-store.js";
import { transitionJob } from "../../src/core/job-transition.js";
import type { JobKind, JobRecord } from "../../src/core/jobs.js";
import { createHookCallbackController } from "../../src/mimo/hook-callback.js";
import { runMimoCliStreaming } from "../../src/mimo/streaming-runner.js";
import { claimDueDelivery, readDeliveries } from "../../src/notify/outbox.js";
import { runNotificationWorker } from "../../src/notify/worker.js";
import type { CodexAppServerClient } from "../../src/notify/codex-app-server.js";

const workspaces: string[] = [];
const fakeMimo = path.resolve("test/fixtures/fake-mimo.mjs");

afterEach(() => {
  vi.restoreAllMocks();
  for (const cwd of workspaces.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-integration-"));
  workspaces.push(cwd);
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd });
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "initial\n", "utf8");
  fs.writeFileSync(path.join(cwd, "ci.log"), "failed build\n", "utf8");
  execFileSync("git", ["add", "tracked.txt", "ci.log"], { cwd });
  execFileSync("git", ["commit", "-m", "initial"], { cwd, stdio: "ignore" });
  return cwd;
}

function requests(cwd: string): JobRequestByKind {
  return {
    plan: { cwd, task: "plan it", timeoutMs: 2_000 },
    implement: { cwd, task: "implement it", allowWrite: true, timeoutMs: 2_000 },
    review: { cwd, base: "HEAD", timeoutMs: 2_000 },
    "fix-ci": { cwd, file: "ci.log", task: "fix it", timeoutMs: 2_000 },
    resume: { cwd, jobId: "parent-1", task: "continue", sessionId: "session-parent", timeoutMs: 2_000 },
    compose: { cwd, workflow: "plan", task: "compose it", timeoutMs: 2_000 }
  };
}

function seed(cwd: string, kind: JobKind, target?: JobRecord["notificationTarget"]): JobRecord {
  const request = requests(cwd)[kind];
  return createJobStore(cwd).create({
    kind,
    task: "integration task",
    request,
    notificationTarget: target
  });
}

function workerDependencies(input: {
  mode?: "complete" | "hang";
  callback?: boolean;
  finalText?: string;
  callbackWaitMs?: number;
} = {}): JobWorkerDependencies {
  const mode = input.mode ?? "complete";
  const callback = input.callback ?? true;
  const finalText = input.finalText ?? "Job completed from fake MiMo.";
  return {
    createHookCallbackController: (hookInput) => createHookCallbackController({
      ...hookInput,
      callbackWaitMs: input.callbackWaitMs ?? 100
    }),
    captureProcessIdentity: (pid) => ({
      status: "running",
      identity: `fake-process:${pid}`,
      evidence: "integration fixture"
    }),
    spawnNotificationWorker: () => 999,
    runMimoStreaming: (cwd, args, options) => runMimoCliStreaming(cwd, args, {
      ...options,
      env: {
        ...options.env,
        FAKE_MIMO_MODE: mode,
        FAKE_MIMO_CALLBACK: callback ? "1" : "0",
        FAKE_MIMO_FINAL_TEXT: finalText
      },
      spawnProcess: (spawnCwd, _mimoArgs, env) => spawn(process.execPath, [fakeMimo], {
        cwd: spawnCwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }),
      terminateProcessTree: async (_pid, child) => { child.kill(); }
    })
  };
}

async function runFake(cwd: string, job: JobRecord, options: Parameters<typeof workerDependencies>[0] = {}) {
  await runJobWorker(cwd, job.id, workerDependencies(options));
  return readJob(cwd, job.id)!;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for integration condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function allFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? allFiles(target) : [target];
  });
}

describe("unified background jobs", () => {
  it.each(["plan", "implement", "review", "fix-ci", "resume", "compose"] as const)(
    "runs %s through the one fake-process worker lifecycle",
    async (kind) => {
      const cwd = workspace();
      const completed = await runFake(cwd, seed(cwd, kind));

      expect(completed).toMatchObject({ kind, status: "completed", pid: null });
      expect(completed.executionCallback).toMatchObject({ outcome: "completed", sessionId: "session-fake" });
      expect(fs.readFileSync(completed.eventsFile, "utf8")).toContain('"type":"text"');
    }
  );

  it("classifies verification failure without changing the execution callback result", async () => {
    const cwd = workspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      task: "verify failure",
      request: { cwd, workflow: "dev", task: "verify failure", verification: ["node -e process.exit(7)"], timeoutMs: 2_000 }
    });

    const failed = await runFake(cwd, job);

    expect(failed).toMatchObject({ status: "failed", errorCode: "verification_failed" });
    expect(failed.executionCallback?.outcome).toBe("completed");
  });

  it("fails when the internal session.post callback is missing", async () => {
    const cwd = workspace();
    const failed = await runFake(cwd, seed(cwd, "implement"), { callback: false, callbackWaitMs: 20 });

    expect(failed).toMatchObject({ status: "failed", errorCode: "callback_missing" });
  });

  it("times out and terminates the fake MiMo process", async () => {
    const cwd = workspace();
    const request = { cwd, task: "timeout", allowWrite: true, timeoutMs: 40 };
    const job = createJobStore(cwd).create({ kind: "implement", task: "timeout", request });

    const timedOut = await runFake(cwd, job, { mode: "hang", callback: false, callbackWaitMs: 20 });

    expect(timedOut).toMatchObject({ status: "timeout", errorCode: "timeout", pid: null });
  });

  it("honors cancellation while the fake MiMo process is running", async () => {
    const cwd = workspace();
    const job = seed(cwd, "implement");
    const worker = runJobWorker(cwd, job.id, workerDependencies({ mode: "hang", callback: false }));
    await waitUntil(() => readJob(cwd, job.id)?.status === "running" && readJob(cwd, job.id)?.pid !== null);

    await transitionJob(cwd, job.id, { status: "cancelled", summary: "Cancelled by integration test." });
    await worker;

    expect(readJob(cwd, job.id)).toMatchObject({ status: "cancelled", pid: null });
  });

  it.each([
    ["Please clarify which database to use.", "needs_input"],
    ["Blocked by missing permission.", "blocked"]
  ] as const)("classifies attention text as %s", async (finalText, status) => {
    const cwd = workspace();
    const result = await runFake(cwd, seed(cwd, "plan"), { finalText });

    expect(result.status).toBe(status);
  });

  it("recovers a restarted job worker without rerunning MiMo", async () => {
    const cwd = workspace();
    const job = seed(cwd, "implement");
    await transitionJob(cwd, job.id, { status: "running", phase: "starting", summary: "started" });
    const runMimoStreaming = vi.fn();

    await runJobWorker(cwd, job.id, {
      runMimoStreaming,
      terminateOwnedProcess: () => ({ status: "not_running", evidence: "stale process is absent" }),
      spawnNotificationWorker: () => 999
    });

    expect(readJob(cwd, job.id)).toMatchObject({ status: "failed", errorCode: "worker_restarted" });
    expect(runMimoStreaming).not.toHaveBeenCalled();
  });

  it("recovers an expired notification lease after worker restart", async () => {
    const cwd = workspace();
    const job = await runFake(cwd, seed(cwd, "implement", { type: "codex", threadId: "thread-lease" }));
    const claimedAt = new Date("2026-07-16T00:00:00.000Z");
    await claimDueDelivery(job.notificationOutboxFile, claimedAt, 10);
    const deliver = vi.fn(async () => ({ outcome: "delivered" as const }));

    await runNotificationWorker(cwd, {
      now: () => new Date("2026-07-16T00:00:00.011Z"),
      deliver,
      sleep: async () => undefined
    });

    expect(deliver).toHaveBeenCalledOnce();
    expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({ status: "delivered", attempts: 2 });
  });

  it("delivers a deduplicated HMAC webhook without persisting the secret", async () => {
    const cwd = workspace();
    const secret = "integration-secret-value-never-persist";
    const received: Array<{ body: string; headers: http.IncomingHttpHeaders }> = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        received.push({ body, headers: request.headers });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("webhook fixture did not bind");
    try {
      const target = { type: "webhook" as const, url: `http://127.0.0.1:${address.port}/notify`, secretEnv: "INTEGRATION_WEBHOOK_SECRET" };
      const job = await runFake(cwd, seed(cwd, "implement", target));

      await runNotificationWorker(cwd, { env: { INTEGRATION_WEBHOOK_SECRET: secret }, sleep: async () => undefined });
      await runNotificationWorker(cwd, { env: { INTEGRATION_WEBHOOK_SECRET: secret }, sleep: async () => undefined });

      expect(received).toHaveLength(1);
      const body = JSON.parse(received[0].body) as { eventId: string };
      expect(received[0].headers["x-codex-mimo-event-id"]).toBe(body.eventId);
      expect(received[0].headers["x-codex-mimo-signature"]).toBe(
        crypto.createHmac("sha256", secret).update(received[0].body).digest("hex")
      );
      expect(allFiles(path.join(cwd, ".codex-mimo")).map((file) => fs.readFileSync(file, "utf8")).join("\n"))
        .not.toContain(secret);
      expect(readDeliveries(job.notificationOutboxFile)[0].status).toBe("delivered");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("returns a receipt, never waits, and resumes the frozen Codex thread exactly once", async () => {
    const cwd = workspace();
    const receipt = await launchJob({
      kind: "implement",
      cwd,
      task: "notify Codex",
      request: { cwd, task: "notify Codex", allowWrite: true, timeoutMs: 2_000 },
      notify: { type: "codex" }
    }, { env: { CODEX_THREAD_ID: "thread-test" }, spawnJobWorker: () => 123 });
    const completed = await runFake(cwd, readJob(cwd, receipt.jobId)!);
    expect(JSON.parse(fs.readFileSync(completed.notificationOutboxFile, "utf8").trim()).target).toEqual({
      type: "codex", threadId: "thread-test"
    });
    const calls: string[] = [];
    const client: CodexAppServerClient = {
      initialize: async () => { calls.push("initialize"); },
      resumeThread: async (threadId) => { calls.push(`thread/resume:${threadId}`); return { exists: true, busy: false }; },
      startTurn: async (threadId, prompt) => { calls.push(`turn/start:${threadId}:${prompt}`); },
      close: async () => undefined
    };
    const waitToolCalls = 0;

    await runNotificationWorker(cwd, { createCodexClient: () => client, sleep: async () => undefined });
    await runNotificationWorker(cwd, { createCodexClient: () => client, sleep: async () => undefined });

    expect(receipt.status).toBe("queued");
    expect(waitToolCalls).toBe(0);
    expect(calls.filter((call) => call.startsWith("thread/resume"))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("turn/start"))).toHaveLength(1);
    expect(calls.filter((call) => call === "initialize")).toHaveLength(1);
    expect(calls.find((call) => call.startsWith("turn/start"))).toContain("Call mimo_result");
  });
});
