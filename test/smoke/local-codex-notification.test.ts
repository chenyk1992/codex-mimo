import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mimoImplement, mimoResult } from "../../src/codex/tools.js";
import { runJobWorker } from "../../src/core/job-worker.js";
import { readJob } from "../../src/core/job-store.js";
import { readDeliveries } from "../../src/notify/outbox.js";
import { runNotificationWorker } from "../../src/notify/worker.js";
import { createCodexAppServerClient, type CodexAppServerClient } from "../../src/notify/codex-app-server.js";

const enabled = process.env.RUN_LOCAL_CODEX_NOTIFY_SMOKE === "1";
const threadId = process.env.CODEX_THREAD_ID;
const describeSmoke = enabled ? describe : describe.skip;

describeSmoke("local Codex notification", () => {
  it("queues one packaged implement job and resumes the injected task once without waiting", async () => {
    if (!threadId) throw new Error("CODEX_THREAD_ID must be injected by the current Codex task.");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-codex-notify-smoke-"));
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Smoke Test"], { cwd });
    fs.writeFileSync(path.join(cwd, "README.md"), "smoke workspace\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd });
    execFileSync("git", ["commit", "-m", "initial"], { cwd, stdio: "ignore" });

    const receipt = await mimoImplement({
      cwd,
      task: "Inspect the workspace without changing files and report that the smoke task completed.",
      allowWrite: true,
      timeoutMs: 300_000
    }, {
      env: { ...process.env, CODEX_THREAD_ID: threadId },
      spawnJobWorker: () => process.pid
    });
    expect(receipt.status).toBe("queued");

    await runJobWorker(cwd, receipt.jobId, { spawnNotificationWorker: () => process.pid });
    const terminal = readJob(cwd, receipt.jobId)!;
    expect(["completed", "failed", "needs_input", "blocked"]).toContain(terminal.status);

    const calls: string[] = [];
    const actual = createCodexAppServerClient();
    const counted: CodexAppServerClient = {
      initialize: async () => { calls.push("initialize"); await actual.initialize(); },
      resumeThread: async (id) => { calls.push(`thread/resume:${id}`); return actual.resumeThread(id); },
      startTurn: async (id, prompt) => { calls.push(`turn/start:${id}:${prompt}`); await actual.startTurn(id, prompt); },
      close: () => actual.close()
    };
    const waitToolCalls = 0;
    await runNotificationWorker(cwd, { createCodexClient: () => counted });

    const resumedResult = await mimoResult({ cwd, jobId: receipt.jobId });
    expect(resumedResult).toMatchObject({ jobId: receipt.jobId, status: terminal.status });
    expect(waitToolCalls).toBe(0);
    expect(calls.filter((call) => call.startsWith(`thread/resume:${threadId}`))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith(`turn/start:${threadId}`))).toHaveLength(1);
    expect(calls.find((call) => call.startsWith(`turn/start:${threadId}`))).toContain("Call mimo_result");
    expect(readDeliveries(terminal.notificationOutboxFile)).toHaveLength(1);
    expect(readDeliveries(terminal.notificationOutboxFile)[0]).toMatchObject({ status: "delivered", attempts: 1 });
  }, 360_000);
});
