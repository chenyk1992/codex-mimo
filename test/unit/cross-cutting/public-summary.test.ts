import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createComposeReport, writeComposeReport } from "../../../src/compose/report.js";
import { appendMcpToolAudit } from "../../../src/codex/tool-audit.js";
import { mimoJobs, mimoResult, mimoStatus } from "../../../src/codex/tools.js";
import { appendRawAndNormalizedEvent, readRecentJobLogLines } from "../../../src/core/job-log.js";
import { createJobStore, readJob } from "../../../src/core/job-store.js";
import { readJobSignals } from "../../../src/core/job-signals.js";
import { transitionJob } from "../../../src/core/job-transition.js";
import { buildCodexNotificationPrompt } from "../../../src/notify/codex-adapter.js";
import type { NotificationDelivery } from "../../../src/notify/types.js";
import { buildNotificationPayload } from "../../../src/notify/webhook-adapter.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("public progress summary boundary", () => {
  it("keeps raw streaming text only in the sanctioned normalized events artifact", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-public-summary-"));
    roots.push(cwd);
    const marker = "RAW_STREAM_SENTINEL_OBJECTIVE_COMMAND_ERROR_PATH";
    const job = createJobStore(cwd).create({
      kind: "implement",
      task: "work",
      request: { cwd, task: "work", allowWrite: true }
    });
    await transitionJob(cwd, job.id, {
      status: "running",
      phase: "starting",
      summary: "starting"
    });
    const normalized = await Promise.all([
      appendRawAndNormalizedEvent(cwd, job.id, JSON.stringify({ type: "text", text: marker })),
      appendRawAndNormalizedEvent(cwd, job.id, JSON.stringify({ type: "error", error: marker })),
      appendRawAndNormalizedEvent(cwd, job.id, JSON.stringify({
        type: "tool_use",
        part: { type: "tool", tool: "bash", state: { input: { command: marker } } }
      })),
      appendRawAndNormalizedEvent(cwd, job.id, JSON.stringify({ type: "diff", path: marker }))
    ]);

    expect(fs.readFileSync(job.eventsFile, "utf8")).toContain(marker);
    expect(JSON.stringify(readJob(cwd, job.id))).not.toContain(marker);
    expect(readRecentJobLogLines(job.logFile, 20).join("\n")).not.toContain(marker);
    expect(JSON.stringify(readJobSignals(job.signalsFile))).not.toContain(marker);
    expect(JSON.stringify(await mimoStatus({ cwd, jobId: job.id }))).not.toContain(marker);
    expect(JSON.stringify(await mimoJobs({ cwd, all: true }))).not.toContain(marker);

    await transitionJob(cwd, job.id, {
      status: "completed",
      summary: marker,
      executionCallback: {
        invocationId: "inv-public-summary",
        outcome: "error",
        error: marker
      }
    });
    const compact = await mimoResult({ cwd, jobId: job.id });
    expect(JSON.stringify(compact)).not.toContain(marker);

    const full = await mimoResult({ cwd, jobId: job.id, level: "full" });
    expect(full).toMatchObject({ output: marker });

    const report = createComposeReport({
      id: job.id,
      createdAt: job.createdAt,
      workflow: "dev",
      cwd,
      requestedSkills: ["compose:execute"],
      status: "failed",
      events: normalized.filter((event) => event !== undefined),
      diff: { changedFiles: [], diffStat: "", diff: "" },
      verification: [],
      executionCallback: {
        invocationId: "inv-public-summary",
        outcome: "error",
        error: marker
      },
      error: marker,
      reportDir: path.join(cwd, "reports"),
      eventsDir: path.join(cwd, "report-events"),
      diffsDir: path.join(cwd, "diffs")
    });
    writeComposeReport(report);
    expect(JSON.stringify(report)).not.toContain(marker);
    expect(fs.readFileSync(report.reportPaths.json, "utf8")).not.toContain(marker);
    expect(fs.readFileSync(report.reportPaths.markdown, "utf8")).not.toContain(marker);
    expect(fs.readFileSync(report.reportPaths.eventsJsonl, "utf8")).not.toContain(marker);

    const auditFile = path.join(cwd, "audit.jsonl");
    appendMcpToolAudit("mimo_result", { CODEX_MIMO_TOOL_AUDIT_FILE: auditFile });
    expect(fs.readFileSync(auditFile, "utf8")).not.toContain(marker);

    const delivery: NotificationDelivery = {
      id: `${job.id}:2:codex`,
      eventId: `${job.id}:2:codex`,
      jobId: job.id,
      signalCursor: 2,
      target: { type: "codex", threadId: "thread-1" },
      status: "pending",
      attempts: 0,
      createdAt: job.createdAt
    };
    const prompt = buildCodexNotificationPrompt(delivery, readJob(cwd, job.id)!, {
      cursor: 2,
      jobId: job.id,
      kind: "blocked",
      level: "warn",
      createdAt: job.createdAt,
      status: "blocked",
      summary: marker
    });
    expect(prompt).toContain("MIMO_CALLBACK_RESULT_V2");
    expect(prompt).not.toContain(marker);
    expect(prompt).not.toContain('"output"');

    const webhookPayload = buildNotificationPayload(
      {
        ...delivery,
        id: `${job.id}:2:webhook`,
        eventId: `${job.id}:2:webhook`,
        target: { type: "webhook", url: "https://example.test/hook", secretEnv: "HOOK_SECRET" }
      },
      readJob(cwd, job.id)!,
      {
        cursor: 2,
        jobId: job.id,
        kind: "blocked",
        level: "warn",
        createdAt: job.createdAt,
        status: "blocked",
        summary: marker
      }
    );
    expect(JSON.stringify(webhookPayload)).not.toContain(marker);
  });
});
