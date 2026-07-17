import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  spawn,
  execFileSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { JobRequestByKind } from "../../src/core/job-definitions.js";
import { launchJob } from "../../src/core/job-launcher.js";
import { runJobWorker, type JobWorkerDependencies } from "../../src/core/job-worker.js";
import { createJobStore, readJob } from "../../src/core/job-store.js";
import { transitionJob } from "../../src/core/job-transition.js";
import type { JobKind, JobRecord } from "../../src/core/jobs.js";
import { createHookCallbackController } from "../../src/mimo/hook-callback.js";
import { runMimoCliStreaming } from "../../src/mimo/streaming-runner.js";
import { readDeliveries } from "../../src/notify/outbox.js";
import { dispatchNextDelivery } from "../../src/notify/dispatcher.js";
import { runNotificationWorker } from "../../src/notify/worker.js";
import { createCodexAppServerClient } from "../../src/notify/codex-app-server.js";

const workspaces: string[] = [];
const children = new Set<ChildProcess>();
const fakeMimo = path.resolve("test/fixtures/fake-mimo.mjs");
const fakeCodexAppServer = path.resolve("test/fixtures/fake-codex-app-server.mjs");
const processJobWorker = path.resolve("test/fixtures/process-job-worker.mjs");
const processNotifyWorker = path.resolve("test/fixtures/process-notify-worker.mjs");

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...children].map((child) => stopChild(child, true)));
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
    resume: {
      cwd,
      jobId: "parent-1",
      task: "continue",
      sessionId: "session-parent",
      executionPolicy: { agent: "build", writesAllowed: true },
      timeoutMs: 2_000
    },
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
  secretProbeName?: string;
  secretProbeFile?: string;
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
        FAKE_MIMO_FINAL_TEXT: finalText,
        ...(input.secretProbeName ? { FAKE_MIMO_SECRET_PROBE_NAME: input.secretProbeName } : {}),
        ...(input.secretProbeFile ? { FAKE_MIMO_SECRET_PROBE_FILE: input.secretProbeFile } : {})
      },
      spawnProcess: (spawnCwd, _mimoArgs, env) => spawn(process.execPath, [fakeMimo], {
        cwd: spawnCwd,
        env,
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

function track<T extends ChildProcess>(child: T): T {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function stopChild(child: ChildProcess, tree: boolean): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (tree && process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
    } catch {}
  } else {
    try { child.kill("SIGKILL"); } catch {}
  }
  await waitForExit(child).catch(() => undefined);
}

function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Child ${child.pid} did not exit.`)), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function readJsonLines(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

  it("recovers a crashed job-worker child, terminates its owned MiMo tree, and does not rerun it", async () => {
    const cwd = workspace();
    const job = seed(cwd, "implement");
    const checkpoint = path.join(cwd, "mimo-checkpoint.json");
    const invocations = path.join(cwd, "mimo-invocations.log");
    const childEnv = {
      ...process.env,
      FAKE_MIMO_PATH: fakeMimo,
      FAKE_MIMO_CHECKPOINT_FILE: checkpoint,
      FAKE_MIMO_INVOCATIONS_FILE: invocations
    };
    const first = track(spawn(process.execPath, [processJobWorker, cwd, job.id], {
      cwd,
      env: childEnv,
      stdio: "ignore",
      windowsHide: true
    }));
    await waitUntil(() => fs.existsSync(checkpoint) && readJob(cwd, job.id)?.pid !== null, 10_000);
    const owned = JSON.parse(fs.readFileSync(checkpoint, "utf8")) as {
      pid: number;
      descendantPid: number;
    };
    expect(processIsRunning(owned.pid)).toBe(true);
    expect(processIsRunning(owned.descendantPid)).toBe(true);

    await stopChild(first, false);
    expect(readJob(cwd, job.id)).toMatchObject({ status: "running", pid: owned.pid });

    const second = track(spawn(process.execPath, [processJobWorker, cwd, job.id], {
      cwd,
      env: childEnv,
      stdio: "ignore",
      windowsHide: true
    }));
    await waitForExit(second, 10_000);
    await waitUntil(() => !processIsRunning(owned.pid) && !processIsRunning(owned.descendantPid), 5_000);

    expect(readJob(cwd, job.id)).toMatchObject({
      status: "failed",
      errorCode: "worker_restarted",
      pid: null,
    });
    expect(fs.readFileSync(invocations, "utf8").trim().split(/\r?\n/)).toHaveLength(1);
  });

  it("recovers an expired lease after a notify-worker child crashes during HTTP delivery", async () => {
    const cwd = workspace();
    const secret = "notify-process-secret";
    let requestCount = 0;
    let successfulResponses = 0;
    let firstRequest!: () => void;
    const firstRequestReceived = new Promise<void>((resolve) => { firstRequest = resolve; });
    const server = http.createServer((_request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        firstRequest();
        return;
      }
      successfulResponses += 1;
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("notify fixture did not bind");
    const target = {
      type: "webhook" as const,
      url: `http://127.0.0.1:${address.port}/notify`,
      secretEnv: "INTEGRATION_WEBHOOK_SECRET"
    };
    const job = await runFake(cwd, seed(cwd, "implement", target));
    const env = {
      ...process.env,
      INTEGRATION_WEBHOOK_SECRET: secret,
      FAKE_NOTIFY_LEASE_MS: "150"
    };
    try {
      const first = track(spawn(process.execPath, [processNotifyWorker, cwd], {
        cwd,
        env,
        stdio: "ignore",
        windowsHide: true
      }));
      await firstRequestReceived;
      await waitUntil(() => readDeliveries(job.notificationOutboxFile)[0]?.status === "delivering");
      await stopChild(first, false);
      const leaseUntil = Date.parse(readDeliveries(job.notificationOutboxFile)[0].leaseUntil!);
      await waitUntil(() => Date.now() > leaseUntil, 2_000);

      const second = track(spawn(process.execPath, [processNotifyWorker, cwd], {
        cwd,
        env,
        stdio: "ignore",
        windowsHide: true
      }));
      await waitForExit(second, 5_000);

      expect(requestCount).toBe(2);
      expect(successfulResponses).toBe(1);
      expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
        status: "delivered",
        attempts: 2
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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

  (process.platform === "win32" ? it : it.skip)(
    "handles Windows webhook-secret casing while keeping the secret out of MiMo and persisted artifacts",
    async () => {
    const cwd = workspace();
    const actualSecretName = "INTEGRATION_ISOLATED_WEBHOOK_SECRET";
    const targetSecretName = "integration_isolated_webhook_secret";
    const secret = "isolated-secret-value-never-persist";
    const probeFile = path.join(cwd, "mimo-secret-probe.txt");
    let body = "";
    let signature = "";
    const server = http.createServer((request, response) => {
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        signature = String(request.headers["x-codex-mimo-signature"] ?? "");
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("webhook fixture did not bind");
    const previous = process.env[actualSecretName];
    process.env[actualSecretName] = secret;
    try {
      const target = {
        type: "webhook" as const,
        url: `http://127.0.0.1:${address.port}/notify`,
        secretEnv: targetSecretName
      };
      const completed = await runFake(cwd, seed(cwd, "implement", target), {
        secretProbeName: targetSecretName,
        secretProbeFile: probeFile
      });

      expect(fs.readFileSync(probeFile, "utf8")).toBe("missing");
      await runNotificationWorker(cwd, { sleep: async () => undefined });
      expect(signature).toBe(crypto.createHmac("sha256", secret).update(body).digest("hex"));
      const persisted = allFiles(path.join(cwd, ".codex-mimo"))
        .map((file) => fs.readFileSync(file, "utf8"))
        .join("\n");
      expect(persisted).not.toContain(secret);
      expect(readDeliveries(completed.notificationOutboxFile)[0].status).toBe("delivered");
    } finally {
      if (previous === undefined) delete process.env[actualSecretName];
      else process.env[actualSecretName] = previous;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("records zero MCP wait calls and resumes the frozen Codex thread once over stdio RPC", async () => {
    const cwd = workspace();
    const toolCalls: string[] = [];
    const mcpServer = new McpServer({ name: "integration-recorder", version: "1.0.0" });
    mcpServer.registerTool("mimo_implement", {
      inputSchema: { task: z.string() }
    }, async ({ task }) => {
      toolCalls.push("mimo_implement");
      const launched = await launchJob({
        kind: "implement",
        cwd,
        task,
        request: { cwd, task, allowWrite: true, timeoutMs: 2_000 },
        notify: { type: "codex" }
      }, { env: { CODEX_THREAD_ID: "thread-frozen" }, spawnJobWorker: () => 123 });
      return { content: [{ type: "text", text: JSON.stringify(launched) }] };
    });
    mcpServer.registerTool("mimo_wait", { inputSchema: {} }, async () => {
      toolCalls.push("mimo_wait");
      return { content: [{ type: "text", text: "{}" }] };
    });
    const client = new Client({ name: "integration-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({ name: "mimo_implement", arguments: { task: "notify Codex" } });
    const content = response.content[0];
    if (content.type !== "text") throw new Error("Expected text tool result.");
    const receipt = JSON.parse(content.text) as Awaited<ReturnType<typeof launchJob>>;
    await client.close();
    await mcpServer.close();

    const completed = await runFake(cwd, readJob(cwd, receipt.jobId)!);
    expect(JSON.parse(fs.readFileSync(completed.notificationOutboxFile, "utf8").trim()).target).toEqual({
      type: "codex", threadId: "thread-frozen"
    });
    const marker = path.join(cwd, "codex-app-server.jsonl");
    const createClient = () => createCodexAppServerClient({
      spawnProcess: (_command, _args, options) => track(spawn(process.execPath, [fakeCodexAppServer], {
        ...options,
        cwd,
        env: { ...options.env, FAKE_CODEX_MARKER: marker },
        stdio: ["pipe", "pipe", "pipe"]
      })) as ChildProcessWithoutNullStreams
    });

    const delivered = await dispatchNextDelivery(cwd, { createCodexClient: createClient });
    const duplicate = await dispatchNextDelivery(cwd, { createCodexClient: createClient });
    expect(delivered).toMatchObject({ outcome: "settled", delivery: { status: "delivered" } });
    expect(duplicate).toEqual({ outcome: "idle" });
    const calls = readJsonLines(marker);
    const methods = calls.map((call) => call.method);

    expect(receipt.status).toBe("queued");
    expect(toolCalls).toEqual(["mimo_implement"]);
    expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
    expect(methods.filter((method) => method === "initialized")).toHaveLength(1);
    expect(methods.filter((method) => method === "thread/resume")).toHaveLength(1);
    expect(methods.filter((method) => method === "turn/start")).toHaveLength(1);
    const resume = calls.find((call) => call.method === "thread/resume")!;
    expect(resume.params).toEqual({ threadId: "thread-frozen" });
    const start = calls.find((call) => call.method === "turn/start")!;
    const params = start.params as { threadId: string; input: Array<{ text: string }> };
    expect(params.threadId).toBe("thread-frozen");
    expect(params.input[0].text).toContain("Call mimo_result");
    expect(params.input[0].text).toContain(`jobId "${receipt.jobId}"`);
    expect(params.input[0].text).toContain(`cwd "${cwd.replace(/\\/g, "\\\\")}"`);
  });
});
