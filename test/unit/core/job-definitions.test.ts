import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JOB_DEFINITIONS,
  bindJobDefinition,
  getJobDefinition,
  type JobRequestByKind
} from "../../../src/core/job-definitions.js";
import type { ExecutionCallbackSummary, JobKind, JobRecord } from "../../../src/core/jobs.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-definitions-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const cwd of tempDirs.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

function makeJob<Kind extends JobKind>(kind: Kind, request: JobRequestByKind[Kind]): JobRecord {
  const cwd = request.cwd;
  return {
    id: `${kind}-1`,
    kind,
    cwd,
    task: "test task",
    request,
    status: "queued",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    changedFiles: [],
    verification: [],
    logFile: path.join(cwd, `${kind}.log`),
    eventsFile: path.join(cwd, `${kind}.events.jsonl`),
    signalsFile: path.join(cwd, `${kind}.signals.jsonl`),
    notificationOutboxFile: path.join(cwd, `${kind}.outbox.jsonl`)
  };
}

describe("job definition registry", () => {
  it("registers exactly the six executable kinds", () => {
    expect(Object.keys(JOB_DEFINITIONS).sort()).toEqual([
      "compose",
      "fix-ci",
      "implement",
      "plan",
      "resume",
      "review"
    ]);
  });

  it.each([
    ["plan", { cwd: "E:/project", task: "plan it" }, "plan"],
    ["implement", { cwd: "E:/project", task: "build it", allowWrite: true }, "build"],
    ["review", { cwd: "E:/project", base: "HEAD" }, "plan"],
    ["fix-ci", { cwd: "E:/project", file: "ci.log", task: "fix it" }, "build"],
    ["resume", { cwd: "E:/project", jobId: "parent-1", task: "continue", sessionId: "ses_1" }, "build"],
    ["compose", { cwd: "E:/project", workflow: "dev", task: "build it" }, "compose"]
  ] as const)("uses the fixed MiMo agent for %s", async (kind, request, agent) => {
    const definition = getJobDefinition(kind);
    const prompt = await definition.buildPrompt(request);
    const args = definition.buildMimoArgs(request, prompt);

    expect(args).toContain("--agent");
    expect(args[args.indexOf("--agent") + 1]).toBe(agent);
  });

  it("resumes from the parent session", async () => {
    const definition = getJobDefinition("resume");
    const request = { cwd: "E:/project", jobId: "parent-1", task: "continue", sessionId: "ses_1" };
    const prompt = await definition.buildPrompt(request);

    expect(definition.buildMimoArgs(request, prompt)).toContain("ses_1");
  });

  it("passes model, fixed attachments, and transported prompt files to MiMo", async () => {
    const cwd = tempDir();
    const definition = getJobDefinition("fix-ci");
    const request = {
      cwd,
      file: "ci.log",
      task: "修复 Windows 构建",
      model: "mimo-v2",
      timeoutMs: 42_000
    };
    const prompt = await definition.buildPrompt(request);
    const args = definition.buildMimoArgs(request, prompt);

    expect(prompt.files).toHaveLength(1);
    expect(args).toEqual(expect.arrayContaining(["--model", "mimo-v2", "--file", "ci.log"]));
    expect(args.filter((item) => item === "--file")).toHaveLength(2);
  });

  it("builds Compose prompts with the selected workflow skill chain and reference file", async () => {
    const definition = getJobDefinition("compose");
    const request = {
      cwd: "E:/project",
      workflow: "execute-plan" as const,
      file: "approved-plan.md",
      task: "execute the approved plan"
    };
    const prompt = await definition.buildPrompt(request);
    const args = definition.buildMimoArgs(request, prompt);

    expect(prompt.message).toContain("compose:execute -> compose:tdd -> compose:verify -> compose:review");
    expect(prompt.message).toContain("@approved-plan.md");
    expect(args).toEqual(expect.arrayContaining(["--agent", "compose", "--file", "approved-plan.md"]));
  });

  it("validates a stored request once and returns bound zero-argument methods", async () => {
    const cwd = tempDir();
    const job = makeJob("plan", { cwd, task: "plan the change", model: "mimo-v2" });
    const bound = bindJobDefinition(job);
    job.request = { cwd, task: "", unexpected: true };

    const prompt = await bound.buildPrompt();
    expect(bound.kind).toBe("plan");
    expect(bound.buildMimoArgs(prompt)).toEqual(expect.arrayContaining(["--agent", "plan", "--model", "mimo-v2"]));
  });

  it("rejects an invalid stored request before any work starts", () => {
    const cwd = tempDir();
    const job = makeJob("review", { cwd, base: "HEAD" });
    job.request = { cwd, base: 12 };

    expect(() => bindJobDefinition(job)).toThrow(/review job request/i);
  });

  it("rejects a non-positive timeout at bind time", () => {
    const cwd = tempDir();
    const job = makeJob("plan", { cwd, task: "plan it" });
    job.request = { cwd, task: "plan it", timeoutMs: 0 };

    expect(() => bindJobDefinition(job)).toThrow(/plan job request/i);
  });
});

describe("job finalization", () => {
  it("uses the shared classifier and returns an outcome without mutating the job", async () => {
    const cwd = tempDir();
    const job = makeJob("implement", { cwd, task: "implement it", allowWrite: true });
    const before = structuredClone(job);
    const callback: ExecutionCallbackSummary = {
      invocationId: "inv-1",
      outcome: "completed",
      sessionId: "ses-1",
      receivedAt: "2026-07-16T00:00:01.000Z"
    };
    const outcome = await getJobDefinition("implement").finalize({
      job,
      request: job.request as JobRequestByKind["implement"],
      run: { stdout: '{"type":"message","text":"done"}\n', stderr: "", exitCode: 0, pid: 10 },
      events: [{ type: "message", text: "done", raw: { type: "message", text: "done" } }],
      executionCallback: callback,
      diff: { changedFiles: ["src/app.ts"], diffStat: "", diff: "" },
      commitChanges: { commits: [], changedFiles: [] },
      verification: []
    });

    expect(outcome).toMatchObject({
      status: "completed",
      summary: "done",
      sessionId: "ses-1",
      changedFiles: ["src/app.ts"],
      executionCallback: callback
    });
    expect(job).toEqual(before);
  });

  it("runs Compose verification and report writing during finalization", async () => {
    const cwd = tempDir();
    const request: JobRequestByKind["compose"] = { cwd, workflow: "dev", task: "build it" };
    const job = makeJob("compose", request);
    const writeReport = vi.fn();
    const runVerification = vi.fn(async () => [{
      command: "npm test",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      passed: true,
      durationMs: 12
    }]);

    const outcome = await getJobDefinition("compose").finalize({
      job,
      request,
      mimoArgs: ["run", "--format", "json"],
      run: { stdout: '{"type":"message","text":"done"}\n', stderr: "", exitCode: 0, pid: 10 },
      events: [{ type: "message", text: "done", raw: { type: "message", text: "done" } }],
      executionCallback: { invocationId: "inv-1", outcome: "completed", sessionId: "ses-1" },
      gitStatusBefore: { short: "", dirty: false },
      gitStatusAfter: { short: " M src/app.ts", dirty: true },
      diff: { changedFiles: ["src/app.ts"], diffStat: "1 file changed", diff: "diff" },
      commitChanges: { commits: [], changedFiles: [] },
      verification: [],
      deps: { runVerification, writeComposeReport: writeReport }
    });

    expect(runVerification).toHaveBeenCalledWith(cwd, []);
    expect(writeReport).toHaveBeenCalledOnce();
    const report = writeReport.mock.calls[0][0];
    expect(report.executionCallback).toMatchObject({
      invocationId: "inv-1",
      outcome: "completed",
      sessionId: "ses-1"
    });
    expect("callback" in report).toBe(false);
    expect(outcome).toMatchObject({ status: "completed", changedFiles: ["src/app.ts"] });
    expect(outcome.reportPaths).toMatchObject({ json: expect.any(String), markdown: expect.any(String) });
  });
});
