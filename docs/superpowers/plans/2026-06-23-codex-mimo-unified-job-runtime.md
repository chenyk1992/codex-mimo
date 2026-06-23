# Codex-MiMo Unified Job Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified job runtime so Codex-MiMo can run long MiMoCode tasks in the background, expose status/result/cancel tools, persist partial progress, and resume follow-up work from job-linked MiMo sessions.

**Architecture:** Add a focused job runtime under `src/core/` that owns job records, state files, logs, event persistence, process metadata, phase inference, compact rendering, cancellation, and worker handoff. Compose becomes the first background-capable workflow by sharing the existing report pipeline with a streaming CLI runner; other tools move onto the same runtime in later tasks without preserving old synchronous internals as special cases.

**Tech Stack:** TypeScript ESM, Node.js `child_process`, `fs`, `path`, `execa` where synchronous foreground helpers remain useful, Zod MCP schemas, Vitest.

---

## Implementation Principle

The implementation should optimize for the target job-runtime architecture, not for preserving every historical internal helper. Existing public tool names may stay, but internals can be replaced when that produces a simpler and more coherent runtime.

Do not implement compatibility shims for old private helper signatures unless a test proves they are still needed.

## Final Acceptance Criteria

- `mimo_compose` supports `background: true` and returns a stable `jobId` without waiting for MiMoCode to finish.
- `mimo_status`, `mimo_result`, `mimo_cancel`, and `mimo_jobs` are registered in the MCP server and covered by schemas.
- A background Compose job writes `.codex-mimo/jobs/<job-id>.json`, `.log`, and `.events.jsonl`.
- A completed background Compose job links to the Compose JSON report, Markdown report, events JSONL, and diff file when present.
- A failed, cancelled, timed-out, or malformed-output job still keeps partial events and logs.
- Job status includes `status`, `phase`, elapsed time, summary, changed files, session ID when known, recent progress, and action hints.
- Job result returns compact final output and paths to full artifacts.
- Job cancellation marks the job `cancelled` and attempts process-tree termination.
- `mimo_resume_job` creates a child job from a parent job with a `sessionId`; it rejects jobs without a session ID.
- Existing Compose verification, read-only violation detection, semantic failure detection, and report writing remain covered by tests.
- `npm run lint`, `npm test`, and `npm run build` pass.

---

## File Structure

Create:

- `src/core/jobs.ts`: shared job types, status/phase enums, compact response types, and small pure helpers.
- `src/core/job-store.ts`: read/write/list/prune job state and per-job files under `.codex-mimo/jobs`.
- `src/core/job-log.ts`: append timestamped log lines and JSONL event lines.
- `src/core/job-phase.ts`: infer job phase and progress summary from normalized MiMo events and verification events.
- `src/core/job-render.ts`: render status, result, launch, cancellation, and list responses.
- `src/core/job-process.ts`: spawn detached workers and terminate process trees.
- `src/core/job-runtime.ts`: high-level lifecycle API used by tool handlers and workers.
- `src/compose/streaming-runner.ts`: streaming MiMo CLI runner that emits normalized events while preserving raw JSONL.
- `src/compose/job-worker.ts`: worker entrypoint for background Compose jobs.
- `test/unit/job-store.test.ts`
- `test/unit/job-phase.test.ts`
- `test/unit/job-render.test.ts`
- `test/unit/job-process.test.ts`
- `test/unit/compose-streaming-runner.test.ts`
- `test/unit/compose-background.test.ts`
- `test/unit/job-tools.test.ts`

Modify:

- `src/compose/events.ts`: export `normalizeMimoEvent()` so streaming code can normalize one line at a time.
- `src/compose/runner.ts`: expose reusable report-building pieces and support injected event stdout from streaming runs.
- `src/compose/report.ts`: ensure failed/cancelled reports can be written with partial event sets.
- `src/core/sessions.ts`: add optional job linkage fields.
- `src/codex/tool-schemas.ts`: add job tool schemas and background/resume-by-job inputs.
- `src/codex/tools.ts`: wire job runtime into Compose and add job management tool handlers.
- `src/codex/mcp-server.ts`: register new MCP tools.
- `src/codex/compact.ts`: include job-linked result fields where needed.
- `src/cli/main.ts` and `src/cli/commands.ts`: add worker command if the CLI command router owns subcommands.
- `test/unit/tool-schemas.test.ts`
- `test/unit/codex-tools.test.ts`
- `test/unit/compose-runner.test.ts`
- `test/unit/compose-events.test.ts`
- `test/unit/cli.test.ts`

---

## Task 1: Define Shared Job Types

**Files:**

- Create: `src/core/jobs.ts`
- Test: `test/unit/jobs.test.ts`

- [ ] **Step 1: Write job type helper tests**

Create `test/unit/jobs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildJobId,
  isActiveJobStatus,
  nowIso,
  type JobRecord
} from "../../src/core/jobs.js";

describe("job types", () => {
  it("builds stable job ids with a prefix and timestamp-safe suffix", () => {
    const id = buildJobId("compose", () => 1234567890, () => "abc123");
    expect(id).toBe("compose-kf12oi-abc123");
  });

  it("detects active statuses", () => {
    expect(isActiveJobStatus("queued")).toBe(true);
    expect(isActiveJobStatus("running")).toBe(true);
    expect(isActiveJobStatus("completed")).toBe(false);
    expect(isActiveJobStatus("failed")).toBe(false);
    expect(isActiveJobStatus("cancelled")).toBe(false);
  });

  it("allows the canonical job record shape", () => {
    const createdAt = nowIso();
    const record: JobRecord = {
      id: "compose-abc",
      kind: "compose",
      cwd: "E:/project/app",
      task: "Run dev workflow",
      request: { workflow: "dev" },
      status: "queued",
      phase: "queued",
      pid: null,
      sessionId: null,
      parentJobId: null,
      createdAt,
      updatedAt: createdAt,
      changedFiles: [],
      verification: [],
      logFile: "E:/project/app/.codex-mimo/jobs/compose-abc.log",
      eventsFile: "E:/project/app/.codex-mimo/jobs/compose-abc.events.jsonl"
    };

    expect(record.kind).toBe("compose");
    expect(record.status).toBe("queued");
  });
});
```

- [ ] **Step 2: Run the new test and confirm it fails**

Run:

```bash
npm test -- jobs.test.ts
```

Expected: fail with an import error for `src/core/jobs.js`.

- [ ] **Step 3: Implement shared job types**

Create `src/core/jobs.ts`:

```ts
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type JobPhase =
  | "queued"
  | "starting"
  | "planning"
  | "investigating"
  | "editing"
  | "verifying"
  | "reviewing"
  | "finalizing"
  | "done"
  | "failed"
  | "cancelled";

export type JobKind = "plan" | "implement" | "review" | "fix-ci" | "compose" | "resume" | "acp";

export interface JobVerification {
  command: string;
  exitCode: number | null;
  passed: boolean;
  durationMs?: number;
}

export interface JobReportPaths {
  json?: string;
  markdown?: string;
  eventsJsonl?: string;
  diff?: string;
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  workflow?: string;
  cwd: string;
  task: string;
  request: unknown;
  status: JobStatus;
  phase: JobPhase;
  pid?: number | null;
  sessionId?: string | null;
  parentJobId?: string | null;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  summary?: string;
  changedFiles: string[];
  verification: JobVerification[];
  reportPaths?: JobReportPaths;
  logFile: string;
  eventsFile: string;
  error?: string;
  errorCode?: string;
}

export interface JobLaunchResult {
  jobId: string;
  status: JobStatus;
  phase: JobPhase;
  summary: string;
  actions: {
    status: "mimo_status";
    result: "mimo_result";
    cancel: "mimo_cancel";
  };
}

export interface JobStatusResult {
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  phase: JobPhase;
  elapsedMs: number | null;
  sessionId: string | null;
  summary: string;
  changedFiles: string[];
  progress: string[];
  actions: {
    result?: "mimo_result";
    cancel?: "mimo_cancel";
  };
}

export interface JobResult {
  jobId: string;
  status: JobStatus;
  summary: string;
  sessionId: string | null;
  changedFiles: string[];
  verification: JobVerification[];
  error?: string;
  errorCode?: string;
  reportPaths?: JobReportPaths;
  resumeHint?: {
    tool: "mimo_resume_job";
    jobId: string;
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function buildJobId(
  prefix: string,
  now: () => number = () => Date.now(),
  random: () => string = () => Math.random().toString(36).slice(2, 8)
): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "job";
  return `${safePrefix}-${now().toString(36)}-${random()}`;
}

export function isActiveJobStatus(status: JobStatus): boolean {
  return status === "queued" || status === "running";
}
```

- [ ] **Step 4: Run test**

Run:

```bash
npm test -- jobs.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/jobs.ts test/unit/jobs.test.ts
git commit -m "feat: define job runtime types"
```

---

## Task 2: Implement Job Store

**Files:**

- Create: `src/core/job-store.ts`
- Test: `test/unit/job-store.test.ts`

- [ ] **Step 1: Write job store tests**

Create `test/unit/job-store.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createJobStore,
  readJob,
  listJobs,
  updateJob,
  resolveJobPaths
} from "../../src/core/job-store.js";

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-job-store-"));
}

describe("job store", () => {
  it("creates a job with per-job paths and stores it in newest-first state", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({
      kind: "compose",
      workflow: "dev",
      task: "Implement login throttling",
      request: { workflow: "dev", task: "Implement login throttling" }
    });

    expect(job.id).toMatch(/^compose-/);
    expect(fs.existsSync(resolveJobPaths(cwd, job.id).jobFile)).toBe(true);
    expect(readJob(cwd, job.id).task).toBe("Implement login throttling");
    expect(listJobs(cwd).map((item) => item.id)).toEqual([job.id]);
  });

  it("updates a job without losing immutable fields", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const job = store.create({
      kind: "compose",
      task: "Run plan",
      request: { workflow: "plan" }
    });

    updateJob(cwd, job.id, {
      status: "running",
      phase: "starting",
      pid: 123
    });

    const updated = readJob(cwd, job.id);
    expect(updated.id).toBe(job.id);
    expect(updated.status).toBe("running");
    expect(updated.phase).toBe("starting");
    expect(updated.pid).toBe(123);
    expect(updated.createdAt).toBe(job.createdAt);
  });

  it("prunes state entries while keeping newest jobs", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd, { maxJobs: 2 });
    const first = store.create({ kind: "compose", task: "one", request: { n: 1 } });
    const second = store.create({ kind: "compose", task: "two", request: { n: 2 } });
    const third = store.create({ kind: "compose", task: "three", request: { n: 3 } });

    const ids = listJobs(cwd).map((job) => job.id);
    expect(ids).toEqual([third.id, second.id]);
    expect(fs.existsSync(resolveJobPaths(cwd, first.id).jobFile)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run:

```bash
npm test -- job-store.test.ts
```

Expected: fail with missing `job-store.js`.

- [ ] **Step 3: Implement job store**

Create `src/core/job-store.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { buildJobId, nowIso, type JobKind, type JobRecord } from "./jobs.js";

const JOBS_DIR_NAME = "jobs";
const STATE_FILE_NAME = "state.json";
const DEFAULT_MAX_JOBS = 50;

interface JobStoreOptions {
  maxJobs?: number;
}

interface CreateJobInput {
  kind: JobKind;
  workflow?: string;
  task: string;
  request: unknown;
  parentJobId?: string | null;
}

interface JobState {
  version: 1;
  jobs: JobRecord[];
}

export function resolveJobDir(cwd: string): string {
  return path.join(cwd, ".codex-mimo", JOBS_DIR_NAME);
}

export function resolveJobStateFile(cwd: string): string {
  return path.join(resolveJobDir(cwd), STATE_FILE_NAME);
}

export function resolveJobPaths(cwd: string, jobId: string) {
  const dir = resolveJobDir(cwd);
  return {
    dir,
    jobFile: path.join(dir, `${jobId}.json`),
    logFile: path.join(dir, `${jobId}.log`),
    eventsFile: path.join(dir, `${jobId}.events.jsonl`)
  };
}

function ensureJobDir(cwd: string): void {
  fs.mkdirSync(resolveJobDir(cwd), { recursive: true });
}

function defaultState(): JobState {
  return { version: 1, jobs: [] };
}

function loadState(cwd: string): JobState {
  const stateFile = resolveJobStateFile(cwd);
  if (!fs.existsSync(stateFile)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as Partial<JobState>;
    return {
      version: 1,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function writeState(cwd: string, state: JobState, maxJobs: number): void {
  ensureJobDir(cwd);
  const nextJobs = [...state.jobs]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, maxJobs);
  const retained = new Set(nextJobs.map((job) => job.id));
  for (const job of state.jobs) {
    if (retained.has(job.id)) continue;
    const paths = resolveJobPaths(cwd, job.id);
    for (const file of [paths.jobFile, paths.logFile, paths.eventsFile]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
  fs.writeFileSync(resolveJobStateFile(cwd), `${JSON.stringify({ version: 1, jobs: nextJobs }, null, 2)}\n`, "utf-8");
}

function writeJobRecord(cwd: string, job: JobRecord): void {
  ensureJobDir(cwd);
  fs.writeFileSync(resolveJobPaths(cwd, job.id).jobFile, `${JSON.stringify(job, null, 2)}\n`, "utf-8");
}

export function createJobStore(cwd: string, options: JobStoreOptions = {}) {
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
  ensureJobDir(cwd);
  return {
    create(input: CreateJobInput): JobRecord {
      const id = buildJobId(input.kind);
      const paths = resolveJobPaths(cwd, id);
      const timestamp = nowIso();
      const job: JobRecord = {
        id,
        kind: input.kind,
        workflow: input.workflow,
        cwd,
        task: input.task,
        request: input.request,
        status: "queued",
        phase: "queued",
        pid: null,
        sessionId: null,
        parentJobId: input.parentJobId ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
        changedFiles: [],
        verification: [],
        logFile: paths.logFile,
        eventsFile: paths.eventsFile
      };
      writeJobRecord(cwd, job);
      const state = loadState(cwd);
      writeState(cwd, { version: 1, jobs: [job, ...state.jobs] }, maxJobs);
      return job;
    }
  };
}

export function listJobs(cwd: string): JobRecord[] {
  return [...loadState(cwd).jobs].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function readJob(cwd: string, jobId: string): JobRecord {
  const file = resolveJobPaths(cwd, jobId).jobFile;
  if (!fs.existsSync(file)) {
    throw new Error(`No job found for ${jobId}.`);
  }
  return JSON.parse(fs.readFileSync(file, "utf-8")) as JobRecord;
}

export function updateJob(cwd: string, jobId: string, patch: Partial<JobRecord>): JobRecord {
  const existing = readJob(cwd, jobId);
  const updated: JobRecord = {
    ...existing,
    ...patch,
    id: existing.id,
    kind: existing.kind,
    cwd: existing.cwd,
    createdAt: existing.createdAt,
    updatedAt: nowIso()
  };
  writeJobRecord(cwd, updated);
  const state = loadState(cwd);
  const jobs = state.jobs.filter((job) => job.id !== jobId);
  writeState(cwd, { version: 1, jobs: [updated, ...jobs] }, DEFAULT_MAX_JOBS);
  return updated;
}
```

- [ ] **Step 4: Run job store tests**

Run:

```bash
npm test -- job-store.test.ts jobs.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/job-store.ts test/unit/job-store.test.ts
git commit -m "feat: persist job runtime state"
```

---

## Task 3: Add Job Logs And Event Persistence

**Files:**

- Create: `src/core/job-log.ts`
- Modify: `src/compose/events.ts`
- Test: `test/unit/job-log.test.ts`
- Test: `test/unit/compose-events.test.ts`

- [ ] **Step 1: Add tests for line persistence**

Create `test/unit/job-log.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendJobEventLine, appendJobLogLine, readRecentJobLogLines } from "../../src/core/job-log.js";

describe("job log", () => {
  it("appends timestamped log lines and reads recent progress", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-job-log-"));
    const logFile = path.join(dir, "job.log");

    appendJobLogLine(logFile, "Starting job.");
    appendJobLogLine(logFile, "Running npm test.");

    const content = fs.readFileSync(logFile, "utf-8");
    expect(content).toContain("Starting job.");
    expect(content).toContain("Running npm test.");
    expect(readRecentJobLogLines(logFile, 1)).toEqual(["Running npm test."]);
  });

  it("appends raw JSONL event lines without changing them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-job-events-"));
    const eventsFile = path.join(dir, "job.events.jsonl");

    appendJobEventLine(eventsFile, "{\"type\":\"message\",\"text\":\"hello\"}");
    appendJobEventLine(eventsFile, "not json");

    expect(fs.readFileSync(eventsFile, "utf-8")).toBe("{\"type\":\"message\",\"text\":\"hello\"}\nnot json\n");
  });
});
```

- [ ] **Step 2: Add a test for exported event normalization**

Modify `test/unit/compose-events.test.ts` with this case:

```ts
import { normalizeMimoEvent } from "../../src/compose/events.js";

it("normalizes one raw event for streaming callers", () => {
  expect(normalizeMimoEvent({ type: "message", text: "hello" })).toMatchObject({
    type: "message",
    text: "hello"
  });
});
```

- [ ] **Step 3: Run tests and confirm failure**

Run:

```bash
npm test -- job-log.test.ts compose-events.test.ts
```

Expected: fail because `job-log.js` and exported `normalizeMimoEvent` are missing.

- [ ] **Step 4: Implement job log helpers**

Create `src/core/job-log.ts`:

```ts
import fs from "node:fs";
import path from "node:path";

function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function timestamp(): string {
  return new Date().toISOString();
}

function stripTimestamp(line: string): string {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

export function appendJobLogLine(logFile: string, message: string): void {
  const normalized = message.trim();
  if (!normalized) return;
  ensureParent(logFile);
  fs.appendFileSync(logFile, `[${timestamp()}] ${normalized}\n`, "utf-8");
}

export function appendJobEventLine(eventsFile: string, line: string): void {
  const normalized = line.trimEnd();
  if (!normalized) return;
  ensureParent(eventsFile);
  fs.appendFileSync(eventsFile, `${normalized}\n`, "utf-8");
}

export function readRecentJobLogLines(logFile: string, count = 5): string[] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map(stripTimestamp)
    .slice(-count);
}
```

- [ ] **Step 5: Export single-event normalization**

Modify `src/compose/events.ts` by changing:

```ts
function normalizeMimoEvent(raw: unknown): NormalizedMimoEvent {
```

to:

```ts
export function normalizeMimoEvent(raw: unknown): NormalizedMimoEvent {
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm test -- job-log.test.ts compose-events.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/job-log.ts src/compose/events.ts test/unit/job-log.test.ts test/unit/compose-events.test.ts
git commit -m "feat: persist job logs and events"
```

---

## Task 4: Implement Phase Inference

**Files:**

- Create: `src/core/job-phase.ts`
- Test: `test/unit/job-phase.test.ts`

- [ ] **Step 1: Write phase inference tests**

Create `test/unit/job-phase.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { inferPhaseFromEvent, summarizeEventForLog } from "../../src/core/job-phase.js";
import type { NormalizedMimoEvent } from "../../src/compose/events.js";

function event(input: Partial<NormalizedMimoEvent>): NormalizedMimoEvent {
  return { type: "raw", raw: input, ...input } as NormalizedMimoEvent;
}

describe("job phase inference", () => {
  it("maps tool events to editing, verifying, and investigating", () => {
    expect(inferPhaseFromEvent(event({ type: "tool", toolName: "edit", status: "completed" }))).toBe("editing");
    expect(inferPhaseFromEvent(event({ type: "tool", toolName: "bash", status: "running", text: "npm test" }))).toBe("verifying");
    expect(inferPhaseFromEvent(event({ type: "tool", toolName: "bash", status: "running", text: "ls" }))).toBe("investigating");
  });

  it("maps message and error events", () => {
    expect(inferPhaseFromEvent(event({ type: "message", text: "looking at the failure" }))).toBe("investigating");
    expect(inferPhaseFromEvent(event({ type: "error", text: "boom" }))).toBe("failed");
  });

  it("summarizes events for logs", () => {
    expect(summarizeEventForLog(event({ type: "message", text: "done" }))).toBe("done");
    expect(summarizeEventForLog(event({ type: "tool", toolName: "bash", status: "completed" }))).toBe("Tool bash completed.");
    expect(summarizeEventForLog(event({ type: "raw", text: "raw text" }))).toBe("raw text");
  });
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npm test -- job-phase.test.ts
```

Expected: fail with missing module.

- [ ] **Step 3: Implement phase inference**

Create `src/core/job-phase.ts`:

```ts
import type { NormalizedMimoEvent } from "../compose/events.js";
import type { JobPhase } from "./jobs.js";

function textOf(event: NormalizedMimoEvent): string {
  return String(event.text ?? "").toLowerCase();
}

function looksLikeVerification(text: string): boolean {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|npm test|pnpm test|yarn test|tsc|eslint)\b/i.test(text);
}

export function inferPhaseFromEvent(event: NormalizedMimoEvent): JobPhase | null {
  if (event.type === "error") return "failed";
  if (event.type === "diff") return "editing";
  if (event.type === "message") return "investigating";
  if (event.type !== "tool") return null;

  const tool = String(event.toolName ?? "").toLowerCase();
  const text = textOf(event);

  if (tool === "edit" || tool === "write" || tool === "apply_patch") return "editing";
  if (tool === "bash" && looksLikeVerification(text)) return "verifying";
  if (tool === "bash") return "investigating";
  return "investigating";
}

export function summarizeEventForLog(event: NormalizedMimoEvent): string | null {
  if (event.text?.trim()) return event.text.trim();
  if (event.type === "tool" && event.toolName) {
    const status = event.status ? ` ${event.status}` : "";
    return `Tool ${event.toolName}${status}.`;
  }
  if (event.type === "diff" && event.path) return `Changed ${event.path}.`;
  if (event.type === "usage" && event.usage) return "Usage updated.";
  if (event.type === "error") return "MiMoCode reported an error.";
  return null;
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- job-phase.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/job-phase.ts test/unit/job-phase.test.ts
git commit -m "feat: infer job progress phases"
```

---

## Task 5: Implement Job Rendering

**Files:**

- Create: `src/core/job-render.ts`
- Test: `test/unit/job-render.test.ts`

- [ ] **Step 1: Write rendering tests**

Create `test/unit/job-render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderJobLaunch, renderJobResult, renderJobStatus } from "../../src/core/job-render.js";
import type { JobRecord } from "../../src/core/jobs.js";

function job(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "compose-1",
    kind: "compose",
    workflow: "dev",
    cwd: "E:/project/app",
    task: "Implement login throttling",
    request: { workflow: "dev" },
    status: "running",
    phase: "verifying",
    pid: 123,
    sessionId: "sess_123",
    parentJobId: null,
    createdAt: "2026-06-23T00:00:00.000Z",
    startedAt: "2026-06-23T00:00:01.000Z",
    updatedAt: "2026-06-23T00:00:02.000Z",
    changedFiles: ["src/login.ts"],
    verification: [],
    summary: "Running npm test.",
    logFile: "job.log",
    eventsFile: "job.events.jsonl",
    ...patch
  };
}

describe("job rendering", () => {
  it("renders background launch response", () => {
    expect(renderJobLaunch(job({ status: "queued", phase: "queued" }))).toEqual({
      jobId: "compose-1",
      status: "queued",
      phase: "queued",
      summary: "Started compose job compose-1.",
      actions: {
        status: "mimo_status",
        result: "mimo_result",
        cancel: "mimo_cancel"
      }
    });
  });

  it("renders status with progress and cancel action for active jobs", () => {
    const result = renderJobStatus(job(), {
      nowMs: Date.parse("2026-06-23T00:00:11.000Z"),
      progress: ["Running npm test."]
    });

    expect(result.elapsedMs).toBe(10000);
    expect(result.actions.cancel).toBe("mimo_cancel");
    expect(result.progress).toEqual(["Running npm test."]);
  });

  it("renders result with resume hint when a session exists", () => {
    const result = renderJobResult(job({
      status: "completed",
      phase: "done",
      reportPaths: { json: "report.json", markdown: "report.md" }
    }));

    expect(result.resumeHint).toEqual({ tool: "mimo_resume_job", jobId: "compose-1" });
    expect(result.reportPaths?.json).toBe("report.json");
  });
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npm test -- job-render.test.ts
```

Expected: fail with missing module.

- [ ] **Step 3: Implement renderer**

Create `src/core/job-render.ts`:

```ts
import { isActiveJobStatus, type JobLaunchResult, type JobRecord, type JobResult, type JobStatusResult } from "./jobs.js";

function elapsedMs(job: JobRecord, nowMs = Date.now()): number | null {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, nowMs - start);
}

export function renderJobLaunch(job: JobRecord): JobLaunchResult {
  return {
    jobId: job.id,
    status: job.status,
    phase: job.phase,
    summary: `Started ${job.kind} job ${job.id}.`,
    actions: {
      status: "mimo_status",
      result: "mimo_result",
      cancel: "mimo_cancel"
    }
  };
}

export function renderJobStatus(
  job: JobRecord,
  options: { nowMs?: number; progress?: string[] } = {}
): JobStatusResult {
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    phase: job.phase,
    elapsedMs: elapsedMs(job, options.nowMs),
    sessionId: job.sessionId ?? null,
    summary: job.summary ?? `${job.kind} job ${job.status}.`,
    changedFiles: job.changedFiles,
    progress: options.progress ?? [],
    actions: {
      ...(isActiveJobStatus(job.status) ? { cancel: "mimo_cancel" as const } : { result: "mimo_result" as const })
    }
  };
}

export function renderJobResult(job: JobRecord): JobResult {
  return {
    jobId: job.id,
    status: job.status,
    summary: job.summary ?? `${job.kind} job ${job.status}.`,
    sessionId: job.sessionId ?? null,
    changedFiles: job.changedFiles,
    verification: job.verification,
    error: job.error,
    errorCode: job.errorCode,
    reportPaths: job.reportPaths,
    ...(job.sessionId ? { resumeHint: { tool: "mimo_resume_job" as const, jobId: job.id } } : {})
  };
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- job-render.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/job-render.ts test/unit/job-render.test.ts
git commit -m "feat: render job status and results"
```

---

## Task 6: Add Streaming MiMo CLI Runner

**Files:**

- Create: `src/compose/streaming-runner.ts`
- Test: `test/unit/compose-streaming-runner.test.ts`

- [ ] **Step 1: Write streaming runner tests**

Create `test/unit/compose-streaming-runner.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runMimoCliStreaming } from "../../src/compose/streaming-runner.js";

describe("streaming MiMo CLI runner", () => {
  it("streams JSONL events and returns captured stdout", async () => {
    const seen: string[] = [];
    const result = await runMimoCliStreaming("E:/project/app", ["run"], {
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
          pid: number;
          kill: () => boolean;
        };
        child.pid = 123;
        child.stdout = Readable.from([
          "{\"type\":\"message\",\"text\":\"hello\"}\n",
          "{\"type\":\"tool\",\"tool\":\"bash\",\"status\":\"completed\"}\n"
        ]);
        child.stderr = Readable.from([""]);
        child.kill = () => true;
        queueMicrotask(() => child.emit("close", 0));
        return child;
      },
      onLine: (line) => seen.push(line)
    });

    expect(result.exitCode).toBe(0);
    expect(result.pid).toBe(123);
    expect(seen).toEqual([
      "{\"type\":\"message\",\"text\":\"hello\"}",
      "{\"type\":\"tool\",\"tool\":\"bash\",\"status\":\"completed\"}"
    ]);
    expect(result.stdout).toContain("\"hello\"");
  });

  it("returns stderr and nonzero exit code", async () => {
    const result = await runMimoCliStreaming("E:/project/app", ["run"], {
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
          pid: number;
          kill: () => boolean;
        };
        child.pid = 456;
        child.stdout = Readable.from([""]);
        child.stderr = Readable.from(["failed\n"]);
        child.kill = () => true;
        queueMicrotask(() => child.emit("close", 2));
        return child;
      }
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("failed\n");
  });
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npm test -- compose-streaming-runner.test.ts
```

Expected: fail with missing module.

- [ ] **Step 3: Implement streaming runner**

Create `src/compose/streaming-runner.ts`:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

export interface StreamingRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  pid: number | null;
}

interface StreamingRunOptions {
  timeoutMs?: number;
  onLine?: (line: string) => void;
  onStderr?: (chunk: string) => void;
  spawnProcess?: (cwd: string, args: string[]) => ChildProcess;
}

function defaultSpawn(cwd: string, args: string[]): ChildProcess {
  return spawn("mimo", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

export async function runMimoCliStreaming(
  cwd: string,
  args: string[],
  options: StreamingRunOptions = {}
): Promise<StreamingRunResult> {
  const child = (options.spawnProcess ?? defaultSpawn)(cwd, args);
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  let timedOut = false;

  const timeout = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs)
    : null;

  const stdoutDone = new Promise<void>((resolve) => {
    if (!child.stdout) {
      resolve();
      return;
    }
    const reader = readline.createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      stdoutParts.push(`${line}\n`);
      options.onLine?.(line);
    });
    reader.on("close", resolve);
  });

  const stderrDone = new Promise<void>((resolve) => {
    if (!child.stderr) {
      resolve();
      return;
    }
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderrParts.push(chunk);
      options.onStderr?.(chunk);
    });
    child.stderr.on("end", resolve);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(timedOut ? 124 : code ?? 1));
  });

  if (timeout) clearTimeout(timeout);
  await Promise.all([stdoutDone, stderrDone]);

  return {
    stdout: stdoutParts.join(""),
    stderr: stderrParts.join(""),
    exitCode,
    pid: child.pid ?? null
  };
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- compose-streaming-runner.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/compose/streaming-runner.ts test/unit/compose-streaming-runner.test.ts
git commit -m "feat: stream mimo cli output"
```

---

## Task 7: Extract Compose Report Builder For Reuse

**Files:**

- Modify: `src/compose/runner.ts`
- Test: `test/unit/compose-runner.test.ts`

- [ ] **Step 1: Add tests for exported report builder**

Modify `test/unit/compose-runner.test.ts` with:

```ts
import { buildComposeReportFromRun } from "../../src/compose/runner.js";

it("builds a compose report from captured streaming stdout", () => {
  const report = buildComposeReportFromRun({
    id: "run-1",
    createdAt: "2026-06-23T00:00:00.000Z",
    input: {
      cwd: "E:/project/app",
      workflow: "dev",
      task: "Implement login throttling"
    },
    mimoArgs: ["run", "--format", "json"],
    requestedSkills: ["compose:brainstorm"],
    eventsStdout: "{\"type\":\"message\",\"text\":\"done\"}\n",
    diff: {
      changedFiles: ["src/login.ts"],
      diffStat: "src/login.ts | 1 +",
      diff: ""
    },
    verification: [],
    reportDir: "E:/project/app/.codex-mimo/reports",
    eventsDir: "E:/project/app/.codex-mimo/events",
    diffsDir: "E:/project/app/.codex-mimo/diffs",
    status: "needs_review"
  });

  expect(report.reviewText).toBe("done");
  expect(report.reportPaths.json).toContain("run-1.json");
});
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
npm test -- compose-runner.test.ts
```

Expected: fail because `buildComposeReportFromRun` is not exported.

- [ ] **Step 3: Export the existing build report function**

In `src/compose/runner.ts`, rename the private `buildReport` function to `buildComposeReportFromRun` and export it:

```ts
export function buildComposeReportFromRun(input: {
  id: string;
  createdAt: string;
  input: ComposeRunInput;
  mimoArgs: string[];
  requestedSkills: string[];
  eventsStdout: string;
  diff: GitDiffSnapshot;
  verification: VerificationResult[];
  reportDir: string;
  eventsDir: string;
  diffsDir: string;
  status: "passed" | "failed" | "needs_review";
  gitStatusBefore?: GitStatusSnapshot;
  gitStatusAfter?: GitStatusSnapshot;
  error?: string;
}): ComposeReport {
```

Replace all calls to `buildReport({ ... })` with `buildComposeReportFromRun({ ... })`.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- compose-runner.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/compose/runner.ts test/unit/compose-runner.test.ts
git commit -m "refactor: expose compose report builder"
```

---

## Task 8: Implement Job Runtime Lifecycle

**Files:**

- Create: `src/core/job-runtime.ts`
- Test: `test/unit/job-runtime.test.ts`

- [ ] **Step 1: Write runtime lifecycle tests**

Create `test/unit/job-runtime.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendRuntimeEvent, completeRuntimeJob, failRuntimeJob, startRuntimeJob } from "../../src/core/job-runtime.js";
import { createJobStore, readJob } from "../../src/core/job-store.js";

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-job-runtime-"));
}

describe("job runtime lifecycle", () => {
  it("marks a job running and appends normalized progress", () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      task: "Run dev",
      request: { workflow: "dev" }
    });

    startRuntimeJob(cwd, job.id, { pid: 321 });
    appendRuntimeEvent(cwd, job.id, "{\"type\":\"message\",\"text\":\"Inspecting files\"}");

    const updated = readJob(cwd, job.id);
    expect(updated.status).toBe("running");
    expect(updated.phase).toBe("investigating");
    expect(updated.summary).toBe("Inspecting files");
    expect(fs.readFileSync(updated.eventsFile, "utf-8")).toContain("Inspecting files");
  });

  it("completes and fails jobs with final metadata", () => {
    const cwd = tempWorkspace();
    const store = createJobStore(cwd);
    const complete = store.create({ kind: "compose", task: "complete", request: {} });
    completeRuntimeJob(cwd, complete.id, {
      summary: "done",
      sessionId: "sess_1",
      changedFiles: ["src/a.ts"],
      verification: [],
      reportPaths: { json: "report.json" }
    });

    expect(readJob(cwd, complete.id)).toMatchObject({
      status: "completed",
      phase: "done",
      summary: "done",
      sessionId: "sess_1"
    });

    const failed = store.create({ kind: "compose", task: "fail", request: {} });
    failRuntimeJob(cwd, failed.id, {
      errorCode: "nonzero_exit",
      error: "MiMo failed"
    });

    expect(readJob(cwd, failed.id)).toMatchObject({
      status: "failed",
      phase: "failed",
      errorCode: "nonzero_exit"
    });
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
npm test -- job-runtime.test.ts
```

Expected: fail with missing module.

- [ ] **Step 3: Implement runtime lifecycle**

Create `src/core/job-runtime.ts`:

```ts
import { normalizeMimoEvent } from "../compose/events.js";
import { appendJobEventLine, appendJobLogLine } from "./job-log.js";
import { inferPhaseFromEvent, summarizeEventForLog } from "./job-phase.js";
import { readJob, updateJob } from "./job-store.js";
import type { JobRecord, JobReportPaths, JobVerification } from "./jobs.js";

export function startRuntimeJob(cwd: string, jobId: string, patch: { pid?: number | null } = {}): JobRecord {
  return updateJob(cwd, jobId, {
    status: "running",
    phase: "starting",
    startedAt: new Date().toISOString(),
    pid: patch.pid ?? null,
    summary: "Starting MiMoCode job."
  });
}

export function appendRuntimeEvent(cwd: string, jobId: string, line: string): JobRecord {
  const job = readJob(cwd, jobId);
  appendJobEventLine(job.eventsFile, line);

  let raw: unknown = line;
  try {
    raw = JSON.parse(line);
  } catch {
    raw = { type: "raw", text: line };
  }

  const event = normalizeMimoEvent(raw);
  const phase = inferPhaseFromEvent(event);
  const summary = summarizeEventForLog(event);
  if (summary) appendJobLogLine(job.logFile, summary);

  return updateJob(cwd, jobId, {
    ...(phase ? { phase } : {}),
    ...(summary ? { summary } : {})
  });
}

export function completeRuntimeJob(
  cwd: string,
  jobId: string,
  result: {
    summary: string;
    sessionId?: string | null;
    changedFiles: string[];
    verification: JobVerification[];
    reportPaths?: JobReportPaths;
  }
): JobRecord {
  const job = readJob(cwd, jobId);
  appendJobLogLine(job.logFile, result.summary);
  return updateJob(cwd, jobId, {
    status: "completed",
    phase: "done",
    pid: null,
    completedAt: new Date().toISOString(),
    summary: result.summary,
    sessionId: result.sessionId ?? job.sessionId ?? null,
    changedFiles: result.changedFiles,
    verification: result.verification,
    reportPaths: result.reportPaths
  });
}

export function failRuntimeJob(
  cwd: string,
  jobId: string,
  failure: {
    errorCode: string;
    error: string;
    reportPaths?: JobReportPaths;
  }
): JobRecord {
  const job = readJob(cwd, jobId);
  appendJobLogLine(job.logFile, failure.error);
  return updateJob(cwd, jobId, {
    status: "failed",
    phase: "failed",
    pid: null,
    completedAt: new Date().toISOString(),
    errorCode: failure.errorCode,
    error: failure.error,
    reportPaths: failure.reportPaths ?? job.reportPaths
  });
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- job-runtime.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/job-runtime.ts test/unit/job-runtime.test.ts
git commit -m "feat: add job lifecycle runtime"
```

---

## Task 9: Add Process Control For Workers And Cancellation

**Files:**

- Create: `src/core/job-process.ts`
- Test: `test/unit/job-process.test.ts`

- [ ] **Step 1: Write process control tests**

Create `test/unit/job-process.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildWorkerArgs, terminateJobProcess } from "../../src/core/job-process.js";

describe("job process", () => {
  it("builds compose worker args", () => {
    expect(buildWorkerArgs("compose", "job-1")).toEqual(["compose-worker", "--job-id", "job-1"]);
  });

  it("terminates finite pids through injected killer", () => {
    const kill = vi.fn();
    terminateJobProcess(123, { killProcess: kill });
    expect(kill).toHaveBeenCalledWith(123);
  });

  it("ignores missing pids", () => {
    const kill = vi.fn();
    terminateJobProcess(null, { killProcess: kill });
    expect(kill).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npm test -- job-process.test.ts
```

Expected: fail with missing module.

- [ ] **Step 3: Implement process helpers**

Create `src/core/job-process.ts`:

```ts
import { spawn } from "node:child_process";

export type WorkerKind = "compose";

export function buildWorkerArgs(kind: WorkerKind, jobId: string): string[] {
  if (kind === "compose") return ["compose-worker", "--job-id", jobId];
  return [String(kind), "--job-id", jobId];
}

export function spawnJobWorker(cwd: string, kind: WorkerKind, jobId: string): number | null {
  const child = spawn(process.execPath, ["dist/cli/main.js", ...buildWorkerArgs(kind, jobId)], {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child.pid ?? null;
}

export function terminateJobProcess(
  pid: number | null | undefined,
  options: { killProcess?: (pid: number) => void } = {}
): void {
  if (!Number.isFinite(pid)) return;
  const killProcess = options.killProcess ?? ((targetPid: number) => process.kill(targetPid));
  try {
    killProcess(pid as number);
  } catch {
    // Best-effort cancellation. The job state is still updated by the caller.
  }
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- job-process.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/job-process.ts test/unit/job-process.test.ts
git commit -m "feat: add job worker process control"
```

---

## Task 10: Add Background Compose Worker

**Files:**

- Create: `src/compose/job-worker.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/commands.ts`
- Test: `test/unit/compose-background.test.ts`
- Test: `test/unit/cli.test.ts`

- [ ] **Step 1: Write worker tests with injected dependencies**

Create `test/unit/compose-background.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runComposeJobWorker } from "../../src/compose/job-worker.js";
import { createJobStore, readJob } from "../../src/core/job-store.js";

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-compose-worker-"));
}

describe("compose job worker", () => {
  it("runs a stored compose request and completes the job", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "compose",
      workflow: "dev",
      task: "Implement login throttling",
      request: {
        cwd,
        workflow: "dev",
        task: "Implement login throttling",
        reportDir: path.join(cwd, ".codex-mimo", "reports")
      }
    });

    await runComposeJobWorker(cwd, job.id, {
      runMimoStreaming: async (_cwd, _args, options) => {
        options.onLine?.("{\"type\":\"message\",\"text\":\"done\"}");
        return {
          stdout: "{\"type\":\"message\",\"text\":\"done\"}\n",
          stderr: "",
          exitCode: 0,
          pid: 777
        };
      },
      captureDiff: async () => ({ changedFiles: [], diffStat: "", diff: "" }),
      captureStatus: async () => ({ short: "", dirty: false }),
      runVerification: async () => [],
      now: () => new Date("2026-06-23T00:00:00.000Z")
    });

    const updated = readJob(cwd, job.id);
    expect(updated.status).toBe("completed");
    expect(updated.phase).toBe("done");
    expect(updated.summary).toContain("dev passed");
    expect(updated.reportPaths?.json).toContain(".json");
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
npm test -- compose-background.test.ts
```

Expected: fail with missing worker.

- [ ] **Step 3: Implement compose worker**

Create `src/compose/job-worker.ts`:

```ts
import { buildMimoRunArgs } from "../mimo/run-json.js";
import { captureGitDiff, type GitDiffSnapshot } from "../git/diff.js";
import { captureGitStatus, type GitStatusSnapshot } from "../git/status.js";
import { normalizeVerificationCommands, runVerificationCommands, type VerificationResult } from "./verify.js";
import { buildComposePrompt, getComposeWorkflow, type ComposeWorkflowName } from "./workflow.js";
import { buildComposeReportFromRun } from "./runner.js";
import { writeComposeReport } from "./report.js";
import { runMimoCliStreaming, type StreamingRunResult } from "./streaming-runner.js";
import { appendRuntimeEvent, completeRuntimeJob, failRuntimeJob, startRuntimeJob } from "../core/job-runtime.js";
import { readJob, updateJob } from "../core/job-store.js";

interface ComposeWorkerRequest {
  cwd: string;
  workflow: ComposeWorkflowName;
  task?: string;
  file?: string;
  since?: string;
  model?: string;
  attach?: string;
  session?: string;
  fork?: boolean;
  continue?: boolean;
  verification?: string[];
  reportDir?: string;
  timeoutMs?: number;
}

interface ComposeWorkerDeps {
  runMimoStreaming?: typeof runMimoCliStreaming;
  captureDiff?: (cwd: string, base?: string) => Promise<GitDiffSnapshot>;
  captureStatus?: (cwd: string) => Promise<GitStatusSnapshot>;
  runVerification?: (cwd: string, commands: string[]) => Promise<VerificationResult[]>;
  now?: () => Date;
}

export async function runComposeJobWorker(cwd: string, jobId: string, deps: ComposeWorkerDeps = {}): Promise<void> {
  const job = readJob(cwd, jobId);
  const input = job.request as ComposeWorkerRequest;
  const workflow = getComposeWorkflow(input.workflow);
  const prompt = buildComposePrompt({
    workflow,
    task: input.task,
    file: input.file,
    since: input.since
  });
  const mimoArgs = buildMimoRunArgs({
    cwd: input.cwd,
    agent: "compose",
    model: input.model,
    message: prompt,
    title: `codex-mimo compose ${workflow.name}`,
    session: input.session,
    fork: input.fork,
    attach: input.attach,
    files: input.file ? [input.file] : [],
    continue: input.continue
  });
  const now = deps.now ?? (() => new Date());
  const createdAt = job.createdAt;
  const reportDir = input.reportDir ?? `${input.cwd}/.codex-mimo/reports`;
  const eventsDir = `${input.cwd}/.codex-mimo/events`;
  const diffsDir = `${input.cwd}/.codex-mimo/diffs`;

  startRuntimeJob(cwd, jobId);

  let runResult: StreamingRunResult;
  try {
    runResult = await (deps.runMimoStreaming ?? runMimoCliStreaming)(input.cwd, mimoArgs, {
      timeoutMs: input.timeoutMs,
      onLine: (line) => appendRuntimeEvent(cwd, jobId, line)
    });
    updateJob(cwd, jobId, { pid: runResult.pid });
  } catch (error) {
    failRuntimeJob(cwd, jobId, {
      errorCode: "startup_failed",
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  const captureStatus = deps.captureStatus ?? captureGitStatus;
  const captureDiff = deps.captureDiff ?? captureGitDiff;
  const runVerification = deps.runVerification ?? runVerificationCommands;
  const gitStatusBefore = undefined;
  let diff: GitDiffSnapshot = { changedFiles: [], diffStat: "", diff: "" };
  let gitStatusAfter: GitStatusSnapshot | undefined;
  let verification: VerificationResult[] = [];

  try {
    diff = await captureDiff(input.cwd, input.since ?? "HEAD");
    gitStatusAfter = await captureStatus(input.cwd);
    verification = await runVerification(input.cwd, normalizeVerificationCommands(input.verification, workflow.defaultVerification));
  } catch (error) {
    const report = buildComposeReportFromRun({
      id: job.id,
      createdAt,
      input,
      mimoArgs,
      requestedSkills: workflow.skillChain,
      eventsStdout: runResult.stdout,
      diff,
      verification,
      reportDir,
      eventsDir,
      diffsDir,
      status: "failed",
      gitStatusBefore,
      gitStatusAfter,
      error: error instanceof Error ? error.message : String(error)
    });
    writeComposeReport(report);
    failRuntimeJob(cwd, jobId, {
      errorCode: "report_write_failed",
      error: report.error ?? "Compose post-processing failed.",
      reportPaths: {
        json: report.reportPaths.json,
        markdown: report.reportPaths.markdown,
        eventsJsonl: report.reportPaths.eventsJsonl,
        diff: report.diffPath
      }
    });
    return;
  }

  const status = runResult.exitCode === 0 && verification.every((item) => item.passed)
    ? (verification.length === 0 && diff.changedFiles.length > 0 ? "needs_review" : "passed")
    : "failed";
  const report = buildComposeReportFromRun({
    id: job.id,
    createdAt,
    input,
    mimoArgs,
    requestedSkills: workflow.skillChain,
    eventsStdout: runResult.stdout,
    diff,
    verification,
    reportDir,
    eventsDir,
    diffsDir,
    status,
    gitStatusBefore,
    gitStatusAfter,
    error: status === "failed" ? runResult.stderr || `MiMoCode exited ${runResult.exitCode}` : undefined
  });
  writeComposeReport(report);

  if (status === "failed") {
    failRuntimeJob(cwd, jobId, {
      errorCode: runResult.exitCode === 124 ? "timeout" : "nonzero_exit",
      error: report.error ?? "MiMoCode failed.",
      reportPaths: {
        json: report.reportPaths.json,
        markdown: report.reportPaths.markdown,
        eventsJsonl: report.reportPaths.eventsJsonl,
        diff: report.diffPath
      }
    });
    return;
  }

  completeRuntimeJob(cwd, jobId, {
    summary: `${report.workflow} ${report.status}; ${report.changedFiles.length} changed files.`,
    sessionId: input.session ?? null,
    changedFiles: report.changedFiles,
    verification: report.verification,
    reportPaths: {
      json: report.reportPaths.json,
      markdown: report.reportPaths.markdown,
      eventsJsonl: report.reportPaths.eventsJsonl,
      diff: report.diffPath
    }
  });
}
```

- [ ] **Step 4: Add CLI worker command**

Modify `src/cli/main.ts`. The current CLI is a direct top-level command router, so add the worker branch in that file rather than creating a second routing layer.

The command must accept:

```bash
codex-mimo compose-worker --job-id <job-id> [--cwd <path>]
```

At the top of `src/cli/main.ts`, add:

```ts
import { runComposeJobWorker } from "../compose/job-worker.js";
```

Add a `cwdFlag` extraction near the existing flag extraction:

```ts
const cwdFlag = extractFlag("--cwd");
const effectiveCwd = cwdFlag ?? cwd;
```

Replace use of `cwd` in command handlers touched by this task with `effectiveCwd` only where the command explicitly accepts `--cwd`; keep unrelated command behavior scoped to the task.

Add this branch before the normal `compose` branch:

```ts
} else if (command === "compose-worker") {
  const jobId = extractFlag("--job-id");
  if (!jobId) {
    console.error("Usage: codex-mimo compose-worker --job-id <job-id> [--cwd <path>]");
    process.exit(2);
  }
  await runComposeJobWorker(effectiveCwd, jobId);
```

Do not add a new parser dependency.

- [ ] **Step 5: Add CLI test**

Modify `test/unit/cli.test.ts` to cover that `compose-worker` validates `--job-id`. Use the existing CLI test style. The expected behavior is a nonzero failure or thrown error when `--job-id` is missing.

- [ ] **Step 6: Run tests**

Run:

```bash
npm test -- compose-background.test.ts cli.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/compose/job-worker.ts src/cli/main.ts test/unit/compose-background.test.ts test/unit/cli.test.ts
git commit -m "feat: run compose jobs from workers"
```

---

## Task 11: Add Job Tool Schemas

**Files:**

- Modify: `src/codex/tool-schemas.ts`
- Test: `test/unit/tool-schemas.test.ts`

- [ ] **Step 1: Write schema tests**

Modify `test/unit/tool-schemas.test.ts`:

```ts
import {
  JobCancelInput,
  JobListInput,
  JobResultInput,
  JobStatusInput,
  ResumeJobInput
} from "../../src/codex/tool-schemas.js";

it("accepts job management inputs", () => {
  expect(JobStatusInput.parse({ cwd: "E:/project/app", jobId: "compose-1" }).jobId).toBe("compose-1");
  expect(JobResultInput.parse({ cwd: "E:/project/app" }).cwd).toBe("E:/project/app");
  expect(JobCancelInput.parse({ cwd: "E:/project/app", jobId: "compose-1" }).jobId).toBe("compose-1");
  expect(JobListInput.parse({ cwd: "E:/project/app", all: true }).all).toBe(true);
});

it("accepts resume by job input", () => {
  const parsed = ResumeJobInput.parse({
    cwd: "E:/project/app",
    jobId: "compose-1",
    task: "Continue with the next fix"
  });
  expect(parsed.jobId).toBe("compose-1");
});

it("accepts background compose input", () => {
  const parsed = ComposeInput.parse({
    cwd: "E:/project/app",
    workflow: "dev",
    task: "Implement login throttling",
    background: true
  });
  expect(parsed.background).toBe(true);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npm test -- tool-schemas.test.ts
```

Expected: fail because schemas are missing.

- [ ] **Step 3: Implement schemas**

Modify `src/codex/tool-schemas.ts`:

```ts
export const JobStatusInput = z.object({
  cwd: z.string(),
  jobId: z.string().optional()
});

export const JobResultInput = z.object({
  cwd: z.string(),
  jobId: z.string().optional()
});

export const JobCancelInput = z.object({
  cwd: z.string(),
  jobId: z.string()
});

export const JobListInput = z.object({
  cwd: z.string(),
  all: z.boolean().default(false)
});

export const ResumeJobInput = z.object({
  cwd: z.string(),
  jobId: z.string(),
  task: z.string().min(1),
  background: z.boolean().default(false)
});
```

Extend `ComposeInput`:

```ts
background: z.boolean().default(false),
wait: z.boolean().default(false)
```

Do not add compatibility aliases beyond the names above.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- tool-schemas.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/codex/tool-schemas.ts test/unit/tool-schemas.test.ts
git commit -m "feat: add job tool schemas"
```

---

## Task 12: Wire Background Compose In Tool Handler

**Files:**

- Modify: `src/codex/tools.ts`
- Test: `test/unit/codex-tools.test.ts`

- [ ] **Step 1: Write tool handler tests**

Modify `test/unit/codex-tools.test.ts`:

```ts
import { mimoCompose } from "../../src/codex/tools.js";

it("starts compose in background and returns a job launch response", async () => {
  const result = await mimoCompose(
    {
      cwd: "E:/project/app",
      workflow: "dev",
      task: "Implement login throttling",
      background: true
    },
    {
      spawnJobWorker: () => 999
    }
  );

  expect(result).toMatchObject({
    status: "queued",
    phase: "queued",
    actions: {
      status: "mimo_status",
      result: "mimo_result",
      cancel: "mimo_cancel"
    }
  });
  expect(result.jobId).toMatch(/^compose-/);
});
```

If `mimoCompose` currently does not accept dependency injection, update the test after adding an optional second `deps` parameter.

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
npm test -- codex-tools.test.ts
```

Expected: fail because background branch is missing.

- [ ] **Step 3: Implement background compose branch**

Modify `src/codex/tools.ts`:

```ts
import { createJobStore, updateJob } from "../core/job-store.js";
import { spawnJobWorker } from "../core/job-process.js";
import { renderJobLaunch } from "../core/job-render.js";
```

Change `mimoCompose` to accept dependencies:

```ts
export async function mimoCompose(
  input: unknown,
  deps: { spawnJobWorker?: typeof spawnJobWorker } = {}
): Promise<CompactComposeReport | ReturnType<typeof renderJobLaunch>> {
  const parsed = ComposeInput.parse(input);
  if (parsed.background) {
    const store = createJobStore(parsed.cwd);
    const job = store.create({
      kind: "compose",
      workflow: parsed.workflow,
      task: parsed.task ?? `Run ${parsed.workflow} workflow.`,
      request: parsed
    });
    const pid = (deps.spawnJobWorker ?? spawnJobWorker)(parsed.cwd, "compose", job.id);
    const queued = updateJob(parsed.cwd, job.id, { pid });
    return renderJobLaunch(queued);
  }

  const report = await runComposeWorkflow(parsed);
  return compactComposeReportForCodex(report);
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- codex-tools.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/codex/tools.ts test/unit/codex-tools.test.ts
git commit -m "feat: launch compose jobs in background"
```

---

## Task 13: Add Status, Result, Cancel, Jobs, And Resume-By-Job Handlers

**Files:**

- Modify: `src/codex/tools.ts`
- Test: `test/unit/job-tools.test.ts`

- [ ] **Step 1: Write job tool tests**

Create `test/unit/job-tools.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createJobStore, updateJob } from "../../src/core/job-store.js";
import { mimoCancel, mimoJobs, mimoResult, mimoResumeJob, mimoStatus } from "../../src/codex/tools.js";

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-job-tools-"));
}

describe("job MCP tools", () => {
  it("returns status and result for jobs", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
    updateJob(cwd, job.id, {
      status: "completed",
      phase: "done",
      summary: "dev passed",
      sessionId: "sess_1",
      changedFiles: ["src/a.ts"],
      reportPaths: { json: "report.json" }
    });

    expect(await mimoStatus({ cwd, jobId: job.id })).toMatchObject({
      jobId: job.id,
      status: "completed"
    });
    expect(await mimoResult({ cwd, jobId: job.id })).toMatchObject({
      jobId: job.id,
      summary: "dev passed",
      resumeHint: { tool: "mimo_resume_job", jobId: job.id }
    });
    expect(await mimoJobs({ cwd })).toHaveLength(1);
  });

  it("cancels an active job", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
    updateJob(cwd, job.id, { status: "running", phase: "investigating", pid: 123 });
    const killProcess = vi.fn();

    const result = await mimoCancel({ cwd, jobId: job.id }, { killProcess });

    expect(result.status).toBe("cancelled");
    expect(killProcess).toHaveBeenCalledWith(123);
  });

  it("rejects resume by job when the parent has no session id", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });

    await expect(mimoResumeJob({ cwd, jobId: job.id, task: "continue" })).rejects.toThrow("does not have a sessionId");
  });
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
npm test -- job-tools.test.ts
```

Expected: fail because handlers are missing.

- [ ] **Step 3: Implement job handlers**

Modify `src/codex/tools.ts`:

```ts
import { readRecentJobLogLines } from "../core/job-log.js";
import { listJobs, readJob, updateJob, createJobStore } from "../core/job-store.js";
import { renderJobResult, renderJobStatus } from "../core/job-render.js";
import { terminateJobProcess } from "../core/job-process.js";
import {
  JobCancelInput,
  JobListInput,
  JobResultInput,
  JobStatusInput,
  ResumeJobInput
} from "./tool-schemas.js";
```

Add handlers:

```ts
export async function mimoStatus(input: unknown) {
  const parsed = JobStatusInput.parse(input);
  const jobs = listJobs(parsed.cwd);
  const job = parsed.jobId ? readJob(parsed.cwd, parsed.jobId) : jobs[0];
  if (!job) throw new Error("No jobs recorded for this workspace.");
  return renderJobStatus(job, {
    progress: readRecentJobLogLines(job.logFile, 5)
  });
}

export async function mimoResult(input: unknown) {
  const parsed = JobResultInput.parse(input);
  const jobs = listJobs(parsed.cwd).filter((job) => job.status !== "queued" && job.status !== "running");
  const job = parsed.jobId ? readJob(parsed.cwd, parsed.jobId) : jobs[0];
  if (!job) throw new Error("No finished jobs recorded for this workspace.");
  return renderJobResult(job);
}

export async function mimoJobs(input: unknown) {
  const parsed = JobListInput.parse(input);
  const jobs = listJobs(parsed.cwd);
  return (parsed.all ? jobs : jobs.slice(0, 8)).map((job) => renderJobStatus(job, {
    progress: readRecentJobLogLines(job.logFile, 3)
  }));
}

export async function mimoCancel(
  input: unknown,
  deps: { killProcess?: (pid: number) => void } = {}
) {
  const parsed = JobCancelInput.parse(input);
  const job = readJob(parsed.cwd, parsed.jobId);
  terminateJobProcess(job.pid, { killProcess: deps.killProcess });
  const cancelled = updateJob(parsed.cwd, job.id, {
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt: new Date().toISOString(),
    summary: `Cancelled ${job.id}.`,
    errorCode: "cancelled",
    error: "Cancelled by user."
  });
  return renderJobResult(cancelled);
}

export async function mimoResumeJob(
  input: unknown,
  deps: { spawnJobWorker?: typeof spawnJobWorker } = {}
) {
  const parsed = ResumeJobInput.parse(input);
  const parent = readJob(parsed.cwd, parsed.jobId);
  if (!parent.sessionId) {
    throw new Error(`Job ${parent.id} does not have a sessionId and cannot be resumed.`);
  }
  const store = createJobStore(parsed.cwd);
  const child = store.create({
    kind: "resume",
    workflow: parent.workflow,
    task: parsed.task,
    request: {
      cwd: parsed.cwd,
      workflow: parent.workflow ?? "dev",
      task: parsed.task,
      session: parent.sessionId,
      continue: true,
      background: parsed.background
    },
    parentJobId: parent.id
  });
  if (parsed.background) {
    const pid = (deps.spawnJobWorker ?? spawnJobWorker)(parsed.cwd, "compose", child.id);
    return renderJobLaunch(updateJob(parsed.cwd, child.id, { pid }));
  }
  return {
    jobId: child.id,
    parentJobId: parent.id,
    sessionId: parent.sessionId,
    status: child.status,
    summary: "Resume job created. Run it in background with background=true."
  };
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- job-tools.test.ts codex-tools.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/codex/tools.ts test/unit/job-tools.test.ts
git commit -m "feat: add job management tools"
```

---

## Task 14: Register MCP Tools

**Files:**

- Modify: `src/codex/mcp-server.ts`
- Test: `test/unit/codex-tools.test.ts`

- [ ] **Step 1: Add registration test seam**

Modify `src/codex/mcp-server.ts` to export the canonical tool names before adding the registrations:

```ts
export const MIMO_TOOL_NAMES = [
  "mimo_healthcheck",
  "mimo_plan",
  "mimo_implement",
  "mimo_review",
  "mimo_fix_ci",
  "mimo_resume",
  "mimo_compose",
  "mimo_status",
  "mimo_result",
  "mimo_cancel",
  "mimo_jobs",
  "mimo_resume_job"
] as const;
```

Create or extend a test in `test/unit/codex-tools.test.ts`:

```ts
import { MIMO_TOOL_NAMES } from "../../src/codex/mcp-server.js";

expect(toolNames).toContain("mimo_status");
expect(toolNames).toContain("mimo_result");
expect(toolNames).toContain("mimo_cancel");
expect(toolNames).toContain("mimo_jobs");
expect(toolNames).toContain("mimo_resume_job");
```

Use:

```ts
const toolNames = [...MIMO_TOOL_NAMES];
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
npm test -- codex-tools.test.ts
```

Expected: fail until MCP registrations exist.

- [ ] **Step 3: Register tools**

Modify `src/codex/mcp-server.ts` to register:

```text
mimo_status
mimo_result
mimo_cancel
mimo_jobs
mimo_resume_job
```

Each description should be action-oriented:

- `mimo_status`: "Show active or recent MiMoCode job status."
- `mimo_result`: "Return the compact final result for a finished MiMoCode job."
- `mimo_cancel`: "Cancel an active MiMoCode background job."
- `mimo_jobs`: "List recent MiMoCode jobs for a workspace."
- `mimo_resume_job`: "Create a follow-up job from a previous job's MiMoCode session."

Wire handlers from `src/codex/tools.ts`.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- codex-tools.test.ts tool-schemas.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/codex/mcp-server.ts test/unit/codex-tools.test.ts
git commit -m "feat: expose job runtime mcp tools"
```

---

## Task 15: Link Sessions To Jobs

**Files:**

- Modify: `src/core/sessions.ts`
- Modify: `src/codex/tools.ts`
- Test: `test/unit/session-store.test.ts`

- [ ] **Step 1: Write session store tests**

Create `test/unit/session-store.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../../src/core/sessions.js";

describe("session store job linkage", () => {
  it("persists job metadata with session entries", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-session-store-"));
    const store = new SessionStore(cwd);

    store.save({
      sessionId: "sess_1",
      workflow: "dev",
      task: "Implement login throttling",
      cwd,
      jobId: "compose-1",
      parentJobId: null,
      status: "completed",
      reportPaths: { json: "report.json" },
      summary: "dev passed"
    });

    expect(store.get("sess_1")).toMatchObject({
      jobId: "compose-1",
      status: "completed",
      summary: "dev passed"
    });
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
npm test -- session-store.test.ts
```

Expected: fail because `SessionEntry` does not accept job fields.

- [ ] **Step 3: Extend session store fields**

Modify `src/core/sessions.ts`:

```ts
import type { JobReportPaths, JobStatus } from "./jobs.js";

interface SessionEntry {
  sessionId: string;
  workflow: string;
  task: string;
  cwd: string;
  createdAt: string;
  lastUsedAt: string;
  jobId?: string;
  parentJobId?: string | null;
  status?: JobStatus;
  reportPaths?: JobReportPaths;
  summary?: string;
}
```

Change `save()` to preserve and update these fields:

```ts
save(entry: Omit<SessionEntry, "createdAt" | "lastUsedAt">): void {
  const now = new Date().toISOString();
  const existing = this.sessions.find((s) => s.sessionId === entry.sessionId);
  if (existing) {
    Object.assign(existing, entry, { lastUsedAt: now });
  } else {
    this.sessions.push({ ...entry, createdAt: now, lastUsedAt: now });
  }
  this.persist();
}
```

- [ ] **Step 4: Write sessions from completed job handlers**

In `src/codex/tools.ts`, when a job result contains `sessionId`, save:

```ts
new SessionStore(parsed.cwd).save({
  sessionId: completed.sessionId,
  workflow: completed.workflow ?? completed.kind,
  task: completed.task,
  cwd: parsed.cwd,
  jobId: completed.id,
  parentJobId: completed.parentJobId ?? null,
  status: completed.status,
  reportPaths: completed.reportPaths,
  summary: completed.summary
});
```

If `parsed.cwd` is not in scope, use the job's `cwd`.

- [ ] **Step 5: Run tests**

Run:

```bash
npm test -- session-store.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/sessions.ts src/codex/tools.ts test/unit/session-store.test.ts
git commit -m "feat: link sessions to jobs"
```

---

## Task 16: Preserve Partial Reports For Failed And Cancelled Jobs

**Files:**

- Modify: `src/compose/report.ts`
- Modify: `src/compose/job-worker.ts`
- Test: `test/unit/compose-background.test.ts`
- Test: `test/unit/compose-report.test.ts`

- [ ] **Step 1: Add tests for failed partial report paths**

Extend `test/unit/compose-background.test.ts`:

```ts
it("keeps partial report paths when MiMo exits nonzero", async () => {
  const cwd = tempWorkspace();
  const job = createJobStore(cwd).create({
    kind: "compose",
    workflow: "dev",
    task: "Failing task",
    request: { cwd, workflow: "dev", task: "Failing task" }
  });

  await runComposeJobWorker(cwd, job.id, {
    runMimoStreaming: async (_cwd, _args, options) => {
      options.onLine?.("{\"type\":\"message\",\"text\":\"partial\"}");
      return { stdout: "{\"type\":\"message\",\"text\":\"partial\"}\n", stderr: "boom", exitCode: 2, pid: 111 };
    },
    captureDiff: async () => ({ changedFiles: [], diffStat: "", diff: "" }),
    captureStatus: async () => ({ short: "", dirty: false }),
    runVerification: async () => [],
    now: () => new Date("2026-06-23T00:00:00.000Z")
  });

  const updated = readJob(cwd, job.id);
  expect(updated.status).toBe("failed");
  expect(updated.reportPaths?.json).toContain(".json");
  expect(fs.existsSync(updated.reportPaths!.json!)).toBe(true);
});
```

- [ ] **Step 2: Run tests**

Run:

```bash
npm test -- compose-background.test.ts compose-report.test.ts
```

Expected: fail if failed report paths are not written consistently.

- [ ] **Step 3: Ensure job worker writes reports before failure**

In `src/compose/job-worker.ts`, verify every `failRuntimeJob()` call after MiMo starts has `reportPaths`. For startup failures before any stdout exists, keep report paths optional.

For cancellation, add a helper in the same file:

```ts
function jobReportPaths(report: ComposeReport) {
  return {
    json: report.reportPaths.json,
    markdown: report.reportPaths.markdown,
    eventsJsonl: report.reportPaths.eventsJsonl,
    diff: report.diffPath
  };
}
```

Use `jobReportPaths(report)` in success and failure branches.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- compose-background.test.ts compose-report.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/compose/job-worker.ts src/compose/report.ts test/unit/compose-background.test.ts test/unit/compose-report.test.ts
git commit -m "feat: preserve partial compose artifacts"
```

---

## Task 17: Update Compact Compose Result Contract

**Files:**

- Modify: `src/codex/compact.ts`
- Test: `test/unit/codex-compact.test.ts`

- [ ] **Step 1: Add compact result test for job fields**

Modify `test/unit/codex-compact.test.ts`:

```ts
it("can include job-linked report paths without embedding events", () => {
  const result = compactComposeReportForCodex({
    id: "compose-1",
    createdAt: "2026-06-23T00:00:00.000Z",
    workflow: "dev",
    cwd: "E:/project/app",
    task: "Implement login throttling",
    mimoArgs: ["run"],
    requestedSkills: ["compose:brainstorm"],
    status: "passed",
    events: [{ type: "message", text: "done", raw: { type: "message", text: "done" } }],
    changedFiles: [],
    diffStat: "",
    verification: [],
    reportPaths: {
      json: "report.json",
      markdown: "report.md",
      eventsJsonl: "events.jsonl"
    }
  });

  expect(result.reportPaths.json).toBe("report.json");
  expect(result).not.toHaveProperty("events");
});
```

- [ ] **Step 2: Run tests**

Run:

```bash
npm test -- codex-compact.test.ts
```

Expected: pass or fail only if typings need adjustment.

- [ ] **Step 3: Adjust compact result only if test fails**

If needed, update `CompactComposeReport` so it remains compact and does not include `events`. Keep full events only in report files.

- [ ] **Step 4: Commit if changed**

```bash
git add src/codex/compact.ts test/unit/codex-compact.test.ts
git commit -m "test: lock compact compose job contract"
```

If no source change is needed, commit only the test.

---

## Task 18: Documentation And Operations Update

**Files:**

- Modify: `doc/operations-guide.md`
- Modify: `doc/compose-workflows.md`
- Modify: `README.md`
- Test: none

- [ ] **Step 1: Update operations guide**

Add this section to `doc/operations-guide.md`:

```md
## Background Jobs

Long Compose workflows can run as persisted jobs.

Start a background job through MCP:

```json
{
  "tool": "mimo_compose",
  "arguments": {
    "cwd": "/path/to/repo",
    "workflow": "dev",
    "task": "Implement login throttling",
    "background": true
  }
}
```

Inspect it with `mimo_status`, retrieve final output with `mimo_result`, and cancel active work with `mimo_cancel`.

Job artifacts are stored under `.codex-mimo/jobs`. Compose reports continue to be written under `.codex-mimo/reports`, `.codex-mimo/events`, and `.codex-mimo/diffs`.
```

- [ ] **Step 2: Update compose workflows doc**

Add a short subsection to `doc/compose-workflows.md`:

```md
## Background Execution

Use `background: true` for long workflows such as `dev`, `fix`, `fix-ci`, `execute-plan`, and `parallel`.

The launch response includes a `jobId`. Use job tools to check progress, retrieve results, or cancel:

- `mimo_status`
- `mimo_result`
- `mimo_cancel`
- `mimo_jobs`

Reports remain the full artifact of record. Job responses stay compact so they are safe to return to Codex.
```

- [ ] **Step 3: Update README**

Add the same user-facing concept at a high level:

```md
### Long-Running Jobs

For long Compose workflows, pass `background: true` to receive a `jobId` immediately. Use `mimo_status` for progress, `mimo_result` for final output, and `mimo_cancel` to stop active work. Full artifacts are persisted under `.codex-mimo/`.
```

- [ ] **Step 4: Verify docs are staged**

Run:

```bash
git diff -- doc/operations-guide.md doc/compose-workflows.md README.md
```

Expected: the diff describes background jobs and job tools.

- [ ] **Step 5: Commit**

```bash
git add doc/operations-guide.md doc/compose-workflows.md README.md
git commit -m "docs: describe background job runtime"
```

---

## Task 19: Full Verification And Acceptance Pass

**Files:**

- No planned source files.

- [ ] **Step 1: Run all unit tests**

Run:

```bash
npm test
```

Expected: all Vitest tests pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run lint
```

Expected: TypeScript passes with no errors.

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: `dist/` builds successfully.

- [ ] **Step 4: Manual local smoke test with fake or real MiMo**

If MiMoCode is available:

```bash
node dist/cli/main.js healthcheck
```

Expected: healthcheck reports MiMo availability.

Then start a tiny background Compose job through the MCP tool or direct tool harness. Expected result:

```text
jobId is returned immediately
.codex-mimo/jobs/<job-id>.json exists
mimo_status shows queued or running
mimo_result returns final compact output after completion
```

If MiMoCode is not available, record that manual smoke was skipped because the external CLI is unavailable. Unit tests with fake runners still cover runtime behavior.

- [ ] **Step 5: Acceptance checklist**

Confirm:

- [ ] Background Compose returns `jobId`.
- [ ] Job files are written under `.codex-mimo/jobs`.
- [ ] Status includes phase and recent progress.
- [ ] Result includes compact summary and report paths.
- [ ] Cancel updates active jobs to `cancelled`.
- [ ] Failed jobs keep partial logs/events.
- [ ] Resume-by-job rejects missing `sessionId`.
- [ ] Resume-by-job creates a child job when `sessionId` exists.
- [ ] Full test suite passes.

- [ ] **Step 6: Final commit if verification fixes were needed**

If verification required fixes:

```bash
git add <changed-files>
git commit -m "fix: stabilize job runtime verification"
```

If no fixes were needed, do not create an empty commit.

---

## Execution Notes

- Prefer implementing one task per commit.
- Keep the first pass focused on CLI JSONL background Compose.
- Do not introduce ACP broker code in this implementation.
- Do not implement automatic retries.
- Do not add broad refactors outside files listed in each task.
- Do not return full event logs through MCP responses; return paths instead.
- Treat job phase as a display hint, not a source of correctness.

## Plan Self-Review

Spec coverage:

- Job store and persisted records: Tasks 1, 2, 3, 8.
- Streaming JSONL capture: Tasks 3, 6, 8.
- Background Compose: Tasks 10, 12.
- Status/result/cancel/jobs tools: Tasks 11, 13, 14.
- Partial artifacts on failure/cancel: Tasks 8, 10, 16.
- Session and resume-by-job: Tasks 13, 15.
- ACP broker deferral: Execution notes and no ACP broker tasks.
- Verification and acceptance: Task 19.

Placeholder scan:

- This plan contains no unresolved placeholder steps.

Type consistency:

- Job types are introduced in Task 1 and reused by later tasks.
- Job store helpers are introduced in Task 2 before runtime and tool handlers depend on them.
- Streaming runner is introduced before the Compose worker depends on it.
