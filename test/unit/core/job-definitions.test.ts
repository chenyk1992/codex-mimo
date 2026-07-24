import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JOB_DEFINITIONS,
  bindJobDefinition,
  type JobRequestByKind
} from "../../../src/core/job-definitions.js";
import type { ExecutionCallbackSummary, JobKind, JobRecord } from "../../../src/core/jobs.js";
import { isRuntimeArtifactPath } from "../../../src/core/runtime-paths.js";
import { captureGitDiff } from "../../../src/git/diff.js";

const tempDirs: string[] = [];
const ACTIVE_SIGNAL = new AbortController().signal;

function tempDir(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-definitions-"));
  tempDirs.push(cwd);
  return cwd;
}

function initGitRepo(): string {
  const cwd = tempDir();
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.ts"), "export const value = 1;\n", "utf-8");
  execFileSync("git", ["add", "app.ts"], { cwd });
  execFileSync("git", ["commit", "-m", "initial"], { cwd, stdio: "ignore" });
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
    ["fix-ci", { cwd: "E:/project", file: "ci.log", task: "fix it" }, "build"],
    ["resume", {
      cwd: "E:/project",
      jobId: "parent-1",
      task: "continue",
      sessionId: "ses_1",
      executionPolicy: { agent: "build", writesAllowed: true }
    }, "build"],
    ["compose", { cwd: "E:/project", workflow: "dev", task: "build it" }, "compose"]
  ] as const)("uses the fixed MiMo agent for %s", async (kind, request, agent) => {
    const definition = JOB_DEFINITIONS[kind];
    const prompt = await definition.buildPrompt(request, ACTIVE_SIGNAL);
    const args = definition.buildMimoArgs(request, prompt);

    expect(args).toContain("--agent");
    expect(args[args.indexOf("--agent") + 1]).toBe(agent);
  });

  it("resumes from the parent session", async () => {
    const definition = JOB_DEFINITIONS["resume"];
    const request = {
      cwd: "E:/project",
      jobId: "parent-1",
      task: "continue",
      sessionId: "ses_1",
      executionPolicy: { agent: "build" as const, writesAllowed: true }
    };
    const prompt = await definition.buildPrompt(request, ACTIVE_SIGNAL);

    expect(definition.buildMimoArgs(request, prompt)).toContain("ses_1");
  });

  it.each([
    [{ agent: "plan", writesAllowed: false } as const, "plan", "failed", "read_only_violation"],
    [{ agent: "compose", writesAllowed: false } as const, "compose", "failed", "read_only_violation"],
    [{ agent: "build", writesAllowed: true } as const, "build", "completed", undefined]
  ])("enforces a resumed parent's immutable %j execution policy", async (executionPolicy, agent, status, errorCode) => {
    const cwd = tempDir();
    const request: JobRequestByKind["resume"] = {
      cwd,
      jobId: "parent-1",
      task: "continue",
      sessionId: "ses_1",
      executionPolicy
    };
    const definition = JOB_DEFINITIONS["resume"];
    const prompt = await definition.buildPrompt(request, ACTIVE_SIGNAL);
    const args = definition.buildMimoArgs(request, prompt);
    const outcome = await definition.finalize({
      signal: ACTIVE_SIGNAL,
      job: makeJob("resume", request),
      request,
      run: { stdout: "", stderr: "", exitCode: 0, pid: 1 },
      events: [{ type: "message", text: "done", raw: {} }],
      executionCallback: { invocationId: "inv", outcome: "completed" },
      gitStatusBefore: { short: "", dirty: false, fingerprints: {} },
      gitStatusAfter: {
        short: " M changed.ts",
        dirty: true,
        fingerprints: { "changed.ts": { status: " M", contentHash: "changed" } }
      },
      diff: { changedFiles: ["changed.ts"], diffStat: "", diff: "diff" },
      verification: []
    });

    expect(args[args.indexOf("--agent") + 1]).toBe(agent);
    if (!executionPolicy.writesAllowed) {
      expect(prompt.message).toContain("Do not modify project files; writes under `.mimocode/` are allowed.");
    }    expect(outcome).toMatchObject({ status, ...(errorCode ? { errorCode } : {}) });
  });

  it("rejects an invalid review base before producing a prompt", async () => {
    const cwd = initGitRepo();
    await expect(JOB_DEFINITIONS["review"].buildPrompt({ cwd, base: "missing-ref" }, ACTIVE_SIGNAL))
      .rejects.toThrow(/Git diff capture failed.*missing-ref/i);
  });

  it("cancels review diff capture through its explicit prompt signal", async () => {
    const cwd = initGitRepo();
    const controller = new AbortController();
    controller.abort();

    await expect(JOB_DEFINITIONS["review"].buildPrompt({ cwd, base: "HEAD" }, controller.signal))
      .rejects.toThrow();
  });

  it("describes an empty review diff without creating an attachment", async () => {
    const cwd = initGitRepo();
    const prompt = await JOB_DEFINITIONS["review"].buildPrompt({ cwd, base: "HEAD" }, ACTIVE_SIGNAL);
    const args = JOB_DEFINITIONS["review"].buildMimoArgs({ cwd, base: "HEAD" }, prompt);

    expect(prompt.files).toEqual([]);
    expect(prompt.message).toContain("No changes found against base HEAD");
    expect(args).toEqual(expect.arrayContaining(["--agent", "plan"]));
  });

  it("freezes a large non-ASCII review diff as the exact prompt attachment", async () => {
    const cwd = initGitRepo();
    fs.writeFileSync(path.join(cwd, "app.ts"), `// 中文差异\n${"变更内容".repeat(3_000)}\n`, "utf-8");
    const expected = await captureGitDiff(cwd, "HEAD");
    const definition = JOB_DEFINITIONS["review"];
    const prompt = await definition.buildPrompt(
      { cwd, base: "HEAD", model: "mimo-v2" },
      ACTIVE_SIGNAL
    );
    const args = definition.buildMimoArgs({ cwd, base: "HEAD", model: "mimo-v2" }, prompt);

    expect(prompt.files).toHaveLength(1);
    expect(path.extname(prompt.files[0])).toBe(".diff");
    expect(fs.readFileSync(prompt.files[0], "utf-8")).toBe(expected.diff);
    expect(prompt.message).toContain("base HEAD");
    expect(prompt.message).not.toContain(expected.diff);
    expect(args).toEqual(expect.arrayContaining(["--model", "mimo-v2", "--file", prompt.files[0]]));
    expect(args.filter((item) => item === "--file")).toHaveLength(1);
  });

  it("passes model, fixed attachments, and transported prompt files to MiMo", async () => {
    const cwd = tempDir();
    const definition = JOB_DEFINITIONS["fix-ci"];
    const request = {
      cwd,
      file: "ci.log",
      task: "修复 Windows 构建",
      model: "mimo-v2",
      timeoutMs: 42_000
    };
    const prompt = await definition.buildPrompt(request, ACTIVE_SIGNAL);
    const args = definition.buildMimoArgs(request, prompt);

    expect(prompt.files).toHaveLength(1);
    expect(args).toEqual(expect.arrayContaining(["--model", "mimo-v2", "--file", "ci.log"]));
    expect(args.filter((item) => item === "--file")).toHaveLength(2);
  });

  it("builds Compose prompts with the selected workflow skill chain and reference file", async () => {
    const definition = JOB_DEFINITIONS["compose"];
    const request = {
      cwd: "E:/project",
      workflow: "execute-plan" as const,
      file: "approved-plan.md",
      task: "execute the approved plan"
    };
    const prompt = await definition.buildPrompt(request, ACTIVE_SIGNAL);
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

    const prompt = await bound.buildPrompt(ACTIVE_SIGNAL);
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
    const outcome = await JOB_DEFINITIONS["implement"].finalize({
      signal: ACTIVE_SIGNAL,
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
      summary: "MiMoCode completed the job.",
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

    const outcome = await JOB_DEFINITIONS["compose"].finalize({
      signal: ACTIVE_SIGNAL,
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

    expect(runVerification).toHaveBeenCalledWith(cwd, [], { signal: ACTIVE_SIGNAL });
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

  it("completes a read-only Compose finalize when worker-filtered context drops the cron lock", async () => {
    const cwd = tempDir();
    const request: JobRequestByKind["compose"] = { cwd, workflow: "plan", task: "plan it" };
    const rawChanged = [".mimocode/.cron-lock"];
    const changedFiles = rawChanged.filter((file) => !isRuntimeArtifactPath(file));

    const outcome = await JOB_DEFINITIONS["compose"].finalize({
      signal: ACTIVE_SIGNAL,
      job: makeJob("compose", request),
      request,
      run: { stdout: '{"type":"message","text":"planned"}\n', stderr: "", exitCode: 0, pid: 10 },
      events: [{ type: "message", text: "planned", raw: { type: "message", text: "planned" } }],
      executionCallback: { invocationId: "inv-1", outcome: "completed", sessionId: "ses-1" },
      gitStatusBefore: { short: "", dirty: false, fingerprints: {} },
      gitStatusAfter: {
        short: changedFiles.map((file) => ` M ${file}`).join("\n"),
        dirty: changedFiles.length > 0,
        fingerprints: Object.fromEntries(
          changedFiles.map((file) => [file, { status: " M", contentHash: "after" }])
        )
      },
      diff: { changedFiles, diffStat: "", diff: "" },
      commitChanges: { commits: [], changedFiles: [] },
      verification: [],
      deps: { runVerification: async () => [], writeComposeReport: () => undefined }
    });

    expect(outcome).toMatchObject({ status: "completed", changedFiles: [] });
  });

  it("reports only business files for writable Compose after worker filters the cron lock", async () => {
    const cwd = tempDir();
    const request: JobRequestByKind["compose"] = { cwd, workflow: "dev", task: "build it" };
    const rawChanged = [".mimocode/.cron-lock", "src/app.ts"];
    const changedFiles = rawChanged.filter((file) => !isRuntimeArtifactPath(file));

    const outcome = await JOB_DEFINITIONS["compose"].finalize({
      signal: ACTIVE_SIGNAL,
      job: makeJob("compose", request),
      request,
      run: { stdout: '{"type":"message","text":"done"}\n', stderr: "", exitCode: 0, pid: 10 },
      events: [{ type: "message", text: "done", raw: { type: "message", text: "done" } }],
      executionCallback: { invocationId: "inv-1", outcome: "completed", sessionId: "ses-1" },
      gitStatusBefore: { short: "", dirty: false, fingerprints: {} },
      gitStatusAfter: {
        short: changedFiles.map((file) => ` M ${file}`).join("\n"),
        dirty: changedFiles.length > 0,
        fingerprints: Object.fromEntries(
          changedFiles.map((file) => [file, { status: " M", contentHash: "after" }])
        )
      },
      diff: { changedFiles, diffStat: "1 file changed", diff: "diff" },
      commitChanges: { commits: [], changedFiles: [] },
      verification: [],
      deps: { runVerification: async () => [], writeComposeReport: () => undefined }
    });

    expect(outcome).toMatchObject({ status: "completed", changedFiles: ["src/app.ts"] });
  });

  it.each([
    ["How can I help you?", "failed", "semantic_failure"],
    ["Hello! How can I help you?", "failed", "semantic_failure"],
    ["Hello! What would you like me to help with?", "failed", "semantic_failure"],
    ["Hi, please share your task.", "failed", "semantic_failure"],
    ["Hey, what can I help you with?", "failed", "semantic_failure"],
    ["hELLo, Please share your task.", "failed", "semantic_failure"],
    ["Hi, what task would you like me to implement?", "failed", "semantic_failure"],
    ["您好，有什么可以帮您？", "failed", "semantic_failure"],
    ["Hello world implementation completed successfully.", "completed", undefined],
    ["Hi, the requested change is complete.", "completed", undefined],
    ["Hey, implementation is done.", "completed", undefined],
    ["highlight implementation completed successfully.", "completed", undefined],
    ["The implementation preserves the normal question: How can I help users?", "completed", undefined]
  ] as const)("classifies direct and Compose final text identically: %s", async (finalText, status, errorCode) => {
    const cwd = tempDir();
    const executionCallback: ExecutionCallbackSummary = { invocationId: "inv", outcome: "completed" };
    const run = { stdout: `${JSON.stringify({ type: "message", text: finalText })}\n`, stderr: "", exitCode: 0, pid: 1 };
    const events = [{ type: "message" as const, text: finalText, raw: { type: "message", text: finalText } }];
    const directRequest: JobRequestByKind["implement"] = { cwd, task: "implement", allowWrite: true };
    const composeRequest: JobRequestByKind["compose"] = { cwd, workflow: "dev", task: "implement" };
    const direct = await JOB_DEFINITIONS["implement"].finalize({
      signal: ACTIVE_SIGNAL,
      job: makeJob("implement", directRequest), request: directRequest, run, events, executionCallback, verification: []
    });
    const compose = await JOB_DEFINITIONS["compose"].finalize({
      signal: ACTIVE_SIGNAL,
      job: makeJob("compose", composeRequest), request: composeRequest, run, events, executionCallback,
      verification: [], deps: { runVerification: async () => [], writeComposeReport: () => undefined }
    });

    expect([direct.status, direct.errorCode]).toEqual([status, errorCode]);
    expect([compose.status, compose.errorCode]).toEqual([status, errorCode]);
  });

  it("fails a read-only definition when HEAD changes without a dirty-file delta", async () => {
    const cwd = tempDir();
    const request: JobRequestByKind["plan"] = { cwd, task: "plan" };
    const outcome = await JOB_DEFINITIONS["plan"].finalize({
      signal: ACTIVE_SIGNAL,
      job: makeJob("plan", request), request,
      run: { stdout: '{"type":"message","text":"done"}\n', stderr: "", exitCode: 0, pid: 1 },
      events: [{ type: "message", text: "done", raw: {} }],
      executionCallback: { invocationId: "inv", outcome: "completed" },
      gitHeadBefore: { oid: "aaa", short: "aaa", subject: "before" },
      gitHeadAfter: { oid: "bbb", short: "bbb", subject: "after" },
      gitStatusBefore: { short: "", dirty: false, fingerprints: {} },
      gitStatusAfter: { short: "", dirty: false, fingerprints: {} },
      verification: []
    });

    expect(outcome).toMatchObject({ status: "failed", errorCode: "read_only_violation" });
    expect(outcome.error).toContain("changed HEAD from aaa to bbb");
  });

  it.each(["plan", "implement", "review", "fix-ci", "resume", "compose"] as const)(
    "finalizes %s without mutating the stored job",
    async (kind) => {
      const cwd = kind === "review" ? initGitRepo() : tempDir();
      const requests: JobRequestByKind = {
        plan: { cwd, task: "plan" },
        implement: { cwd, task: "implement", allowWrite: true },
        review: { cwd, base: "HEAD" },
        "fix-ci": { cwd, file: "ci.log", task: "fix" },
        resume: {
          cwd,
          jobId: "parent",
          task: "resume",
          sessionId: "ses-parent",
          executionPolicy: { agent: "build", writesAllowed: true }
        },
        compose: { cwd, workflow: "dev", task: "compose" }
      };
      const request = requests[kind];
      const job = makeJob(kind, request);
      const before = structuredClone(job);
      const bound = bindJobDefinition(job);
      const outcome = await bound.finalize({
        signal: ACTIVE_SIGNAL,
        run: { stdout: '{"type":"message","text":"done"}\n', stderr: "", exitCode: 0, pid: 1 },
        events: [{ type: "message", text: "done", raw: {} }],
        executionCallback: { invocationId: "inv", outcome: "completed" },
        verification: [],
        deps: { runVerification: async () => [], writeComposeReport: () => undefined }
      });

      expect(outcome.status).toBe("completed");
      expect(job).toEqual(before);
    }
  );

  it.each([
    ["direct plan", "plan", { task: "plan it" }, true],
    ["compose plan", "compose", { workflow: "plan" as const, task: "plan it" }, true],
    ["direct implement", "implement", { task: "build it", allowWrite: true as const }, false],
    ["compose review", "compose", { workflow: "review" as const, task: "review it" }, false]
  ] as const)("requires final text only for planning entry points: %s", async (_label, kind, requestPatch, requires) => {
    const cwd = tempDir();
    const request = { cwd, ...requestPatch } as JobRequestByKind[typeof kind];
    const empty = await JOB_DEFINITIONS[kind].finalize({
      signal: ACTIVE_SIGNAL,
      job: makeJob(kind, request),
      request,
      run: { stdout: "", stderr: "", exitCode: 0, pid: 1 },
      events: [],
      executionCallback: { invocationId: "inv", outcome: "completed" },
      verification: [],
      deps: { runVerification: async () => [], writeComposeReport: () => undefined }
    });
    const filled = await JOB_DEFINITIONS[kind].finalize({
      signal: ACTIVE_SIGNAL,
      job: makeJob(kind, request),
      request,
      run: { stdout: '{"type":"message","text":"# Plan"}\n', stderr: "", exitCode: 0, pid: 1 },
      events: [{ type: "message", text: "# Plan", raw: {} }],
      executionCallback: { invocationId: "inv", outcome: "completed" },
      verification: [],
      deps: { runVerification: async () => [], writeComposeReport: () => undefined }
    });

    if (requires) {
      expect(empty).toMatchObject({
        status: "failed",
        errorCode: "result_missing",
        summary: "MiMoCode did not return a final result.",
        error: "MiMoCode did not return a final result."
      });
      expect(JSON.stringify(empty)).not.toMatch(/output|# Plan/);
    } else {
      expect(empty).toMatchObject({ status: "completed" });
    }
    expect(filled).toMatchObject({ status: "completed" });
  });

  it.each(["verification", "report"] as const)("propagates Compose %s writer failures", async (failure) => {
    const cwd = tempDir();
    const request: JobRequestByKind["compose"] = { cwd, workflow: "dev", task: "compose" };
    const bound = bindJobDefinition(makeJob("compose", request));
    const error = new Error(`${failure} exploded`);

    await expect(bound.finalize({
      signal: ACTIVE_SIGNAL,
      run: { stdout: '{"type":"message","text":"done"}\n', stderr: "", exitCode: 0, pid: 1 },
      events: [{ type: "message", text: "done", raw: {} }],
      executionCallback: { invocationId: "inv", outcome: "completed" },
      verification: [],
      deps: {
        runVerification: failure === "verification" ? async () => { throw error; } : async () => [],
        writeComposeReport: failure === "report" ? () => { throw error; } : () => undefined
      }
    })).rejects.toThrow(`${failure} exploded`);
  });
});
