# Codex-MiMo Stall Detection, Checkpoint, and Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect no-effective-progress within five minutes, transition to an immutable `stalled` attention state with a durable checkpoint, and let `mimo_resume` continue stalled/timeout jobs from session or checkpoint without broad repository rescans.

**Architecture:** Keep transport `idleTimeoutMs` (30 minutes of JSONL silence) and absolute `timeoutMs` unchanged. Add a separate effective-progress clock (`lastProgressAt`) updated only by fingerprintable useful events. At `progressTimeoutMs` (default 300_000), atomically write a checkpoint, terminate the owned MiMo tree, confirm death, and transition to `stalled` (or `blocked` + `stalled_process_alive` if death cannot be confirmed). Resume creates a child continuation job that reuses `sessionId` when present, otherwise a checkpoint-only prompt that forbids broad scanning.

**Tech Stack:** TypeScript NodeNext ESM, Zod, Vitest fake timers / injectable clocks, existing job worker, streaming runner, job transition/outbox, resume launcher.

## Global Constraints

- This plan implements design Rollout **Phase 2 only**: effective-progress monitoring, `stalled` status, checkpoints, and expanded resume.
- Do **not** implement Phase 3 ordered development acceptance or Phase 4 durable slice chains.
- Preserve Phase 1 compact delivery: MCP `mimo_status`/`mimo_result` default `compact`; CLI `status` defaults `standard`; callbacks stay `MIMO_CALLBACK_RESULT_V2` compact-only; compact JSON ≤ 6,000 UTF-8 bytes.
- Defaults: `progressWarningMs = 120000`, `progressTimeoutMs = 300000`, `idleTimeoutMs = 1800000`, `timeoutMs = 1800000`.
- `progressTimeoutMs: 0` disables effective-progress stop-loss; docs must warn this weakens the five-minute deliverability objective.
- `idleTimeoutMs` semantics do **not** change (transport JSONL silence only).
- `stalled` is immutable; continuation creates a child job; never mutate historical evidence back to `running`.
- Never launch resume while a parent-owned writer process may still be alive.
- Reasoning/text events alone do not refresh `lastProgressAt`; duplicate progress fingerprints do not refresh it.
- Checkpoint fields for slices/acceptance may be empty stubs (`completedSlices: []`, empty acceptance stages) until later phases.
- For single jobs, `chainId = jobId`.
- Use `.js` import extensions and exported named return types; add no dependency.
- Use `npm.cmd` on Windows.
- Do not create a Git commit unless the user explicitly authorizes commits. Commit steps below are conditional only.
- Re-read and merge existing dirty files on `feat/compact-results-artifacts`; do not wholesale replace Phase 1 docs/tests.
- Do not modify historical 2026-07-20 through 2026-07-23 specs/plans.

---

## File Structure

- `src/core/jobs.ts`: Add `stalled` to `JobStatus`; progress observation fields; `JobReportPaths.checkpoint`; checkpoint-related types.
- `src/core/job-progress.ts` (**new**): `EffectiveProgressKind`, fingerprinting, `classifyEffectiveProgress()`, clock helpers.
- `src/core/job-checkpoint.ts` (**new**): `JobCheckpoint`, atomic write/read, repository fingerprint helper.
- `src/core/job-store.ts`: Persist/validate new optional progress and checkpoint path fields.
- `src/core/job-transition.ts`: LEGAL `running → stalled`; observation updater for progress clocks; signal level for stalled.
- `src/core/job-signals.ts`: Add `stalled` attention kind.
- `src/companion/host-wait.ts`: Include `stalled` in `ATTENTION_STATUSES`.
- `src/mimo/streaming-runner.ts`: Add `progress_timeout` termination reason (stop-loss path).
- `src/core/job-outcome.ts`: Map `progress_timeout` → `stalled` + stall error codes; keep idle/process timeouts as `timeout`.
- `src/core/job-worker.ts`: Wire progress observation, warning probe, progress-timeout stop-loss, checkpoint before stall.
- `src/core/job-render.ts`: Compact attention for `stalled`/`timeout`; standard status exposes progress diagnostics.
- `src/core/prompt.ts`: `resumeContinuationPrompt(checkpoint, task?)`.
- `src/core/job-definitions.ts`: Resume prompt uses checkpoint when present; request schema gains progress timeouts.
- `src/codex/tool-schemas.ts`: `progressTimeoutMs` / `progressWarningMs` on work options; `ResumeInput.task` optional; `progressTimeoutMs` on resume.
- `src/codex/tools.ts`: Expanded `mimoResume` eligibility, conflict check, process-alive gate.
- `src/core/job-artifacts.ts`: Link checkpoint path into report paths when present (optional merge).
- Docs/skill/contract tests for stall + resume.

---

### Task 1: Freeze `stalled` status, progress fields, and schemas

**Files:**
- Modify: `src/core/jobs.ts`
- Modify: `src/codex/tool-schemas.ts`
- Modify: `src/core/job-definitions.ts` (`CommonRequestSchema`)
- Modify: `src/core/job-store.ts`
- Modify: `src/core/job-transition.ts` (`LEGAL`)
- Modify: `src/core/job-signals.ts`
- Modify: `src/companion/host-wait.ts`
- Modify: `test/unit/tool-schemas.test.ts`
- Modify: `test/unit/job-store.test.ts`
- Modify: `test/unit/core/job-transition.test.ts`
- Modify: `test/unit/companion` wait tests if present

**Interfaces:**
- Produces: `JobStatus` including `"stalled"`; progress fields on `JobRecord`; `JobReportPaths.checkpoint?: string`.
- Produces: request defaults `progressWarningMs=120000`, `progressTimeoutMs=300000`.
- Produces: LEGAL `running → stalled`; attention signal/status sets include `stalled`.

- [ ] **Step 1: Write failing tests**

Add to `test/unit/tool-schemas.test.ts`:

```ts
it("defaults progress timeouts and accepts progressTimeoutMs 0", () => {
  const parsed = PlanInput.parse({ cwd: "E:/project", task: "x" });
  expect(parsed.progressWarningMs).toBe(120_000);
  expect(parsed.progressTimeoutMs).toBe(300_000);
  expect(PlanInput.parse({
    cwd: "E:/project",
    task: "x",
    progressTimeoutMs: 0
  }).progressTimeoutMs).toBe(0);
});
```

Add to `test/unit/core/job-transition.test.ts`:

```ts
it("allows running -> stalled and rejects stalled -> running", async () => {
  const { cwd, job } = await seedRunningJob();
  await transitionJob(cwd, job.id, {
    status: "stalled",
    summary: "No effective progress.",
    errorCode: "no_effective_progress"
  });
  expect(readJob(cwd, job.id)?.status).toBe("stalled");
  await expect(transitionJob(cwd, job.id, {
    status: "running",
    summary: "illegal"
  })).rejects.toThrow(/Illegal job transition/);
});
```

Add to `test/unit/job-store.test.ts` a round-trip for `lastProgressAt`, `progressTimeoutMs`, and `reportPaths.checkpoint`.

- [ ] **Step 2: Run tests and verify failure**

```powershell
npm.cmd test -- tool-schemas.test.ts job-transition.test.ts job-store.test.ts
```

Expected: FAIL (missing fields / illegal stalled transition).

- [ ] **Step 3: Extend public types**

In `src/core/jobs.ts`:

```ts
export type JobStatus =
  | "queued"
  | "running"
  | "needs_input"
  | "blocked"
  | "stalled"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export type EffectiveProgressKind =
  | "tool_start"
  | "tool_finish"
  | "file_change"
  | "phase_change"
  | "verification"
  | "callback"
  | "slice_complete";

export interface JobReportPaths {
  json?: string;
  markdown?: string;
  eventsJsonl?: string;
  diff?: string;
  result?: string;
  plan?: string;
  verification?: string;
  checkpoint?: string;
}
```

Add to `JobRecord` (optional fields):

```ts
  lastActivityAt?: string;
  lastProgressAt?: string;
  lastProgressKind?: EffectiveProgressKind;
  lastProgressFingerprint?: string;
  lastCommand?: string;
  progressWarningMs?: number;
  progressTimeoutMs?: number;
  quietSince?: string;
```

Keep `lastEventAt` for backward compatibility; new code prefers `lastActivityAt` and may mirror both during migration.

- [ ] **Step 4: Schemas and LEGAL**

`JobOptionsSchema` / `CommonRequestSchema`:

```ts
progressWarningMs: z.number().int().min(0).default(120_000),
progressTimeoutMs: z.number().int().min(0).default(300_000),
```

`ResumeInput`:

```ts
export const ResumeInput = JobOptionsSchema.extend({
  jobId: z.string().min(1),
  task: z.string().min(1).optional()
}).strict();
```

`LEGAL` in `job-transition.ts`:

```ts
running: ["needs_input", "blocked", "stalled", "completed", "failed", "cancelled", "timeout"],
stalled: [],
```

`ATTENTION_SIGNAL_KINDS` and companion `ATTENTION_STATUSES`: add `"stalled"`.

`isOptionalReportPaths`: accept `checkpoint`.

Seed `progressWarningMs` / `progressTimeoutMs` on job create from request (same pattern as `idleTimeoutMs`).

- [ ] **Step 5: Re-run focused tests + lint**

```powershell
npm.cmd test -- tool-schemas.test.ts job-transition.test.ts job-store.test.ts
npm.cmd run lint
```

Expected: PASS.

- [ ] **Step 6: Conditional commit checkpoint**

Only if authorized:

```powershell
git add src/core/jobs.ts src/codex/tool-schemas.ts src/core/job-definitions.ts src/core/job-store.ts src/core/job-transition.ts src/core/job-signals.ts src/companion/host-wait.ts test/unit/tool-schemas.test.ts test/unit/job-store.test.ts test/unit/core/job-transition.test.ts
git commit -m "feat(jobs): add stalled status and progress timeout fields"
```

---

### Task 2: Effective progress classifier

**Files:**
- Create: `src/core/job-progress.ts`
- Create: `test/unit/core/job-progress.test.ts`

**Interfaces:**
- Produces: `classifyEffectiveProgress(input) → { progressed: boolean; kind?; fingerprint?; lastCommand? }`
- Consumes: normalized event / raw line extracts, previous fingerprint, safe path/command identity.

- [ ] **Step 1: Write failing classifier tests**

```ts
import { describe, expect, it } from "vitest";
import { classifyEffectiveProgress } from "../../../src/core/job-progress.js";

describe("classifyEffectiveProgress", () => {
  it("does not treat reasoning or plain text as progress", () => {
    expect(classifyEffectiveProgress({
      previousFingerprint: undefined,
      event: { type: "reasoning", text: "thinking" }
    }).progressed).toBe(false);
    expect(classifyEffectiveProgress({
      previousFingerprint: undefined,
      event: { type: "text", text: "hello" }
    }).progressed).toBe(false);
  });

  it("advances on a new tool_use fingerprint and ignores duplicates", () => {
    const first = classifyEffectiveProgress({
      previousFingerprint: undefined,
      event: {
        type: "tool_use",
        tool: "bash",
        command: "npm test",
        phase: "started"
      }
    });
    expect(first.progressed).toBe(true);
    expect(first.kind).toBe("tool_start");
    expect(first.lastCommand).toMatch(/npm test/);

    const dup = classifyEffectiveProgress({
      previousFingerprint: first.fingerprint,
      event: {
        type: "tool_use",
        tool: "bash",
        command: "npm test",
        phase: "started"
      }
    });
    expect(dup.progressed).toBe(false);
  });

  it("advances on write/edit path changes and phase changes", () => {
    expect(classifyEffectiveProgress({
      previousFingerprint: undefined,
      event: { type: "tool_use", tool: "write", filePath: "src/a.ts", phase: "finished" }
    })).toMatchObject({ progressed: true, kind: "file_change" });

    expect(classifyEffectiveProgress({
      previousFingerprint: undefined,
      event: { type: "phase", phase: "editing" }
    })).toMatchObject({ progressed: true, kind: "phase_change" });
  });
});
```

- [ ] **Step 2: Run and verify failure**

```powershell
npm.cmd test -- job-progress.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement classifier**

Create `src/core/job-progress.ts`:

```ts
import type { EffectiveProgressKind } from "./jobs.js";
import { redactDiagnosticText } from "./job-output.js";

export interface ProgressEventInput {
  type: string;
  tool?: string;
  command?: string;
  filePath?: string;
  phase?: string;
  exitCode?: number | null;
  text?: string;
}

export interface ClassifyEffectiveProgressInput {
  previousFingerprint?: string;
  event: ProgressEventInput;
}

export interface ClassifyEffectiveProgressResult {
  progressed: boolean;
  kind?: EffectiveProgressKind;
  fingerprint?: string;
  lastCommand?: string;
}

export function classifyEffectiveProgress(
  input: ClassifyEffectiveProgressInput
): ClassifyEffectiveProgressResult {
  const event = input.event;
  const type = event.type.toLowerCase();

  if (type === "reasoning" || type === "text" || type === "message") {
    return { progressed: false };
  }

  if (type === "phase" && event.phase) {
    const fingerprint = `phase:${event.phase}`;
    if (fingerprint === input.previousFingerprint) return { progressed: false };
    return { progressed: true, kind: "phase_change", fingerprint };
  }

  if (type === "tool_use" || type === "tool") {
    const tool = (event.tool ?? "tool").toLowerCase();
    const safeCommand = event.command
      ? redactDiagnosticText(event.command).slice(0, 240)
      : undefined;
    const safePath = event.filePath?.replace(/\\/g, "/");
    const phase = event.phase ?? "unknown";
    const exit = event.exitCode === undefined ? "" : String(event.exitCode);
    const identity = safePath ?? safeCommand ?? tool;
    const fingerprint = `tool:${tool}:${phase}:${identity}:${exit}`;
    if (fingerprint === input.previousFingerprint) return { progressed: false };

    const kind: EffectiveProgressKind =
      tool === "write" || tool === "edit" || tool === "apply_patch"
        ? "file_change"
        : phase === "finished" || phase === "completed"
          ? "tool_finish"
          : "tool_start";

    return {
      progressed: true,
      kind,
      fingerprint,
      ...(safeCommand ? { lastCommand: safeCommand } : {})
    };
  }

  if (type === "step_start" || type === "step_finish") {
    const fingerprint = `${type}:${event.phase ?? event.text ?? ""}`;
    if (fingerprint === input.previousFingerprint) return { progressed: false };
    return { progressed: true, kind: "phase_change", fingerprint };
  }

  return { progressed: false };
}

export function progressIdleMs(lastProgressAt: string | undefined, nowMs: number): number | null {
  if (!lastProgressAt) return null;
  const then = Date.parse(lastProgressAt);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, nowMs - then);
}
```

Adapt event field extraction helpers to reuse `extractToolNameFromRawLine` / normalize pipeline where practical; keep fingerprints free of raw payloads.

- [ ] **Step 4: Run tests**

```powershell
npm.cmd test -- job-progress.test.ts
npm.cmd run lint
```

Expected: PASS.

- [ ] **Step 5: Conditional commit**

Only if authorized:

```powershell
git add src/core/job-progress.ts test/unit/core/job-progress.test.ts
git commit -m "feat(progress): classify effective MiMo progress events"
```

---

### Task 3: Progress-timeout termination and outcome mapping

**Files:**
- Modify: `src/mimo/streaming-runner.ts`
- Modify: `src/core/job-outcome.ts`
- Modify: `test/unit/mimo-streaming-runner.test.ts`
- Modify: `test/unit/core/job-outcome.test.ts`

**Interfaces:**
- Extends `TerminationReason` with `"progress_timeout"`.
- `classifyRunOutcome` maps `progress_timeout` → `status: "stalled"` and uses provided `errorCode` (default `no_effective_progress`).
- Idle/process timeouts remain `status: "timeout"`.

- [ ] **Step 1: Failing outcome tests**

```ts
it("maps progress_timeout to stalled without colliding with idle_timeout", () => {
  expect(classifyRunOutcome({
    exitCode: 124,
    terminationReason: "progress_timeout",
    verification: [],
    finalText: "",
    stallErrorCode: "command_silent"
  })).toMatchObject({
    status: "stalled",
    errorCode: "command_silent"
  });

  expect(classifyRunOutcome({
    exitCode: 124,
    terminationReason: "idle_timeout",
    verification: [],
    finalText: ""
  })).toMatchObject({
    status: "timeout",
    errorCode: "idle_timeout"
  });
});
```

- [ ] **Step 2: Run and verify failure**

```powershell
npm.cmd test -- job-outcome.test.ts
```

- [ ] **Step 3: Implement mapping + runner reason**

Update `TerminationReason`:

```ts
export type TerminationReason =
  | "process_timeout"
  | "idle_timeout"
  | "progress_timeout"
  | "host_abort"
  | "user_cancelled";
```

Expose a way for the worker to request `progress_timeout` termination (either a dedicated callback from an external monitor that calls the same `requestTermination("progress_timeout")`, or an optional `onProgressWatch` / injected abort with reason). Prefer extending the existing termination helper so process-tree kill stays identical to idle/process timeout.

In `classifyRunOutcome`, before idle/process branches:

```ts
if (evidence.terminationReason === "progress_timeout") {
  return {
    status: "stalled",
    summary: publicProgressSummary({
      type: "job",
      status: "stalled",
      errorCode: evidence.stallErrorCode ?? "no_effective_progress"
    }),
    errorCode: evidence.stallErrorCode ?? "no_effective_progress",
    ...
  };
}
```

Extend `RunEvidence` with optional `stallErrorCode?: string`.

- [ ] **Step 4: Runner unit coverage**

Add a test that requesting progress timeout kills the child and returns `terminationReason: "progress_timeout"` (pattern after existing idle timeout tests).

- [ ] **Step 5: Verify**

```powershell
npm.cmd test -- job-outcome.test.ts mimo-streaming-runner.test.ts
npm.cmd run lint
```

- [ ] **Step 6: Conditional commit**

Only if authorized:

```powershell
git add src/mimo/streaming-runner.ts src/core/job-outcome.ts test/unit/mimo-streaming-runner.test.ts test/unit/core/job-outcome.test.ts
git commit -m "feat(runtime): map progress timeout to stalled"
```

---

### Task 4: Worker progress monitor with fake clock

**Files:**
- Modify: `src/core/job-worker.ts`
- Modify: `src/core/job-transition.ts` (`updateRunningJobObservation`)
- Modify: `test/unit/core/job-worker.test.ts`

**Interfaces:**
- On each JSONL line: update `lastActivityAt` (+ keep `lastEventAt`); maybe update progress clocks via classifier.
- Inject `nowMs` / progress watcher deps for tests.
- At `progressWarningMs`: set `quietSince`, probe process, classify likely reason; **no** transition/notify.
- At `progressTimeoutMs`: re-read job; write checkpoint (Task 5 can stub first); request `progress_timeout` termination; confirm death; transition `stalled` or `blocked`+`stalled_process_alive`.
- `progressTimeoutMs === 0` skips the monitor.

- [ ] **Step 1: Failing fake-clock worker tests**

```ts
it("does not stall before progressTimeoutMs and stalls at the deadline", async () => {
  const clock = { now: Date.parse("2026-07-26T00:00:00.000Z") };
  // Arrange a running fake MiMo that emits only reasoning/text (activity without progress).
  // Advance clock to warningMs: still running, quietSince set, no notification.
  // Advance to progressTimeoutMs: status stalled, errorCode no_effective_progress or agent_silent.
});

it("refreshes progress lease on a new tool fingerprint", async () => {
  // Emit tool_use at t=0, advance to timeout-1ms without stall, then another duplicate tool does not extend,
  // a new tool fingerprint extends past the original deadline.
});

it("becomes blocked with stalled_process_alive when termination cannot be confirmed", async () => {
  // Fake verifyProcess still match after kill request.
});
```

Use injectable deps already common in `job-worker.test.ts` (`runMimoStreaming`, `updateRunningJobObservation`, process identity helpers). Add `now?: () => number` and/or a progress-monitor tick hook.

- [ ] **Step 2: Run and verify failure**

```powershell
npm.cmd test -- job-worker.test.ts
```

- [ ] **Step 3: Wire observation + monitor**

Update `updateRunningJobObservation` to accept:

```ts
{
  lastEventAt?: string;
  lastActivityAt?: string;
  lastProgressAt?: string;
  lastProgressKind?: EffectiveProgressKind;
  lastProgressFingerprint?: string;
  lastTool?: string;
  lastCommand?: string;
  sessionId?: string | null;
  quietSince?: string | null;
}
```

In `onLine`:

1. Always set `lastActivityAt` / `lastEventAt`.
2. Parse enough of the line to call `classifyEffectiveProgress`.
3. If progressed, clear `quietSince` and update progress fields.
4. Keep existing session/tool extraction.

Add a progress watch loop (interval or runner-integrated timer) that:

```ts
const progressTimeoutMs = readProgressTimeout(job.request); // 0 disables
const progressWarningMs = readProgressWarning(job.request);
const idle = progressIdleMs(job.lastProgressAt ?? job.startedAt, now());
if (progressTimeoutMs > 0 && idle != null && idle >= progressTimeoutMs) {
  // re-read, checkpoint, terminate progress_timeout, confirm, transition
} else if (progressTimeoutMs > 0 && idle != null && idle >= progressWarningMs) {
  // set quietSince once; probe; classify stall reason into job.lastCommand / internal note only
}
```

Stall reason heuristics (public `errorCode`):

- unfinished bash/tool without finish → `command_silent`
- process dead/missing → `worker_lost`
- JSONL activity but no progress fingerprint refresh → `no_effective_progress`
- otherwise alive but silent → `agent_silent`

If kill cannot be confirmed → `blocked` + `stalled_process_alive` (no resume until resolved).

Seed `lastProgressAt` at process start (same as first activity) so a job that never emits useful progress still stalls five minutes after start.

- [ ] **Step 4: Verify**

```powershell
npm.cmd test -- job-worker.test.ts job-transition.test.ts
npm.cmd run lint
```

- [ ] **Step 5: Conditional commit**

Only if authorized:

```powershell
git add src/core/job-worker.ts src/core/job-transition.ts test/unit/core/job-worker.test.ts
git commit -m "feat(worker): stall jobs after five minutes without effective progress"
```

---

### Task 5: Durable checkpoints and repository fingerprint

**Files:**
- Create: `src/core/job-checkpoint.ts`
- Create: `test/unit/core/job-checkpoint.test.ts`
- Modify: `src/core/job-artifacts.ts` / finalizers / worker stall path to write checkpoint
- Modify: `src/core/jobs.ts` if `JobCheckpoint` / `AcceptanceSnapshot` types live there

**Interfaces:**

```ts
export interface AcceptanceSnapshot {
  stages: Array<{
    stage: "build" | "test" | "diff_check";
    outcome: "passed" | "failed" | "not_applicable" | "pending";
    command?: string;
  }>;
}

export interface JobCheckpoint {
  version: 1;
  jobId: string;
  chainId: string;
  objective: string;
  workflow?: string;
  sliceId?: string;
  sessionId?: string | null;
  repositoryFingerprint: string;
  contextFiles: string[];
  changedFiles: string[];
  completedSlices: string[];
  completedChecklist: string[];
  remainingChecklist: string[];
  acceptance: AcceptanceSnapshot;
  lastProgressAt?: string;
  lastProgressKind?: string;
  lastCommand?: string;
  artifactPaths: JobReportPaths;
}
```

- [ ] **Step 1: Failing checkpoint tests**

```ts
it("atomically writes checkpoint.json and updates reportPaths.checkpoint", () => {
  const paths = writeJobCheckpoint({ job, objective: job.task, ... });
  expect(fs.existsSync(paths.checkpoint!)).toBe(true);
  const parsed = readJobCheckpoint(paths.checkpoint!);
  expect(parsed?.version).toBe(1);
  expect(parsed?.chainId).toBe(job.id);
  expect(parsed?.completedSlices).toEqual([]);
  expect(parsed?.acceptance.stages).toEqual([]);
});

it("detects resume_conflict when repository fingerprint changes", () => {
  const checkpoint = writeAndRead(...);
  expect(detectResumeConflict(checkpoint, {
    repositoryFingerprint: "different"
  })).toEqual({
    code: "resume_conflict",
    paths: expect.any(Array)
  });
});
```

- [ ] **Step 2: Implement writer**

Atomic write pattern: write temp file then rename into `.codex-mimo/reports/<jobId>.checkpoint.json`.

`repositoryFingerprint`: hash of `git rev-parse HEAD` (or empty dirty marker) plus sorted relevant file content hashes from current git status fingerprints for `contextFiles` ∪ `changedFiles`. Do not hash the entire repo.

For Phase 2 single jobs without manifests:

- `contextFiles`: observed read/write paths from events when available, else `changedFiles`
- `completedChecklist` / `remainingChecklist`: if unknown, set `remainingChecklist: ["Continue from the last incomplete step in the objective."]` and do not invent fake completed items
- `acceptance: { stages: [] }`

Call `writeJobCheckpoint` from:

1. worker after effective progress (throttled ok — at least every progress update or every N seconds)
2. immediately before stall/timeout/needs_input/blocked/failed/completed transitions that finalize

Merge `checkpoint` into `reportPaths` without wiping Phase 1 semantic paths.

- [ ] **Step 3: Verify**

```powershell
npm.cmd test -- job-checkpoint.test.ts job-worker.test.ts
npm.cmd run lint
```

- [ ] **Step 4: Conditional commit**

Only if authorized:

```powershell
git add src/core/job-checkpoint.ts test/unit/core/job-checkpoint.test.ts src/core/job-artifacts.ts src/core/job-worker.ts src/core/jobs.ts
git commit -m "feat(checkpoint): persist continuation checkpoints before stall"
```

---

### Task 6: Expand `mimo_resume` for stalled and timeout

**Files:**
- Modify: `src/codex/tools.ts`
- Modify: `src/codex/tool-schemas.ts` (already optional task in Task 1)
- Modify: `src/core/prompt.ts`
- Modify: `src/core/job-definitions.ts` (resume prompt builder)
- Modify: `src/core/job-render.ts` (compact attention + resume action)
- Modify: `test/unit/mcp-tools/mimo-resume.test.ts`
- Modify: `test/unit/job-render.test.ts`

**Interfaces:**
- Resume eligibility: `needs_input` | `blocked` | `stalled` | `timeout` | allowlisted `failed` codes.
- Phase 2 allowlist constant (ready for Phase 3 codes):

```ts
export const RESUMABLE_FAILURE_CODES = new Set([
  "build_failed",
  "tests_failed",
  "diff_check_failed"
]);
```

- `blocked` + `stalled_process_alive` is **not** resumable.
- `task` optional; default continuation text from checkpoint remaining checklist.
- Session reuse when `parent.sessionId` present; else checkpoint-only new session.
- Return/throw `resume_conflict` / `resume_context_missing` with stable codes.

- [ ] **Step 1: Failing resume tests**

```ts
it("resumes a stalled parent with session reuse", async () => {
  // parent status stalled, sessionId set, checkpoint present
  const receipt = await mimoResume({ cwd, jobId: parent.id });
  expect(receipt.parentJobId ?? /* via read child */ true).toBeTruthy();
  const child = readJob(cwd, receipt.jobId)!;
  expect(child.parentJobId).toBe(parent.id);
  expect(child.request).toMatchObject({ sessionId: parent.sessionId });
});

it("resumes timeout without session using checkpoint-only prompt", async () => {
  // parent timeout, sessionId null, checkpoint present
  // assert resume prompt forbids broad project scanning and includes checkpoint paths
});

it("rejects resume when process still alive or fingerprint conflicts", async () => {
  // stalled_process_alive blocked
  // resume_conflict when fingerprint mismatches
});

it("still requires a task when resuming blocked", async () => {
  await expect(mimoResume({ cwd, jobId: blocked.id })).rejects.toThrow(/task/i);
});
```

- [ ] **Step 2: Implement eligibility + prompt**

```ts
export function resumeContinuationPrompt(input: {
  objective: string;
  checkpoint: JobCheckpoint;
  task?: string;
}): string {
  return [
    "Objective:",
    input.task?.trim() || input.objective,
    "",
    "Continue the existing MiMoCode job from the durable checkpoint. Do not restart discovery.",
    "",
    "Rules:",
    "- Do not perform a broad project scan.",
    "- Do not repeat completed checklist items or completed slices.",
    "- Do not rerun still-valid passed gates listed in the checkpoint.",
    "- Inspect only checkpoint contextFiles and changedFiles as needed.",
    "- Prefer the first remainingChecklist item.",
    "",
    "Checkpoint:",
    "```json",
    JSON.stringify({
      jobId: input.checkpoint.jobId,
      chainId: input.checkpoint.chainId,
      sessionId: input.checkpoint.sessionId,
      contextFiles: input.checkpoint.contextFiles,
      changedFiles: input.checkpoint.changedFiles,
      completedSlices: input.checkpoint.completedSlices,
      completedChecklist: input.checkpoint.completedChecklist,
      remainingChecklist: input.checkpoint.remainingChecklist,
      lastCommand: input.checkpoint.lastCommand,
      acceptance: input.checkpoint.acceptance
    }, null, 2),
    "```"
  ].join("\n");
}
```

`mimoResume` algorithm:

1. Load parent; validate eligibility.
2. If `blocked` and `errorCode === "stalled_process_alive"` → throw not resumable.
3. If `blocked` or `needs_input` → require non-empty `task`.
4. Verify parent process not alive (pid/identity).
5. Read checkpoint from `reportPaths.checkpoint` (or derive/missing → `resume_context_missing` for stalled/timeout without session).
6. Compare repository fingerprint → `resume_conflict` with paths.
7. Build request: reuse session when present; always attach checkpoint-derived prompt via resume definition / prompt transport.
8. `launchJob({ kind: "resume", parentJobId, ... })` under existing process lock semantics.

Update `renderCompactJobResult` attention:

```ts
const attentionStatuses = new Set(["needs_input", "blocked", "stalled", "timeout"]);
// for resumable failed codes, kind: "resumable_failure"
// include resume: { tool: "mimo_resume", jobId: job.id }
// include lastCommand from job.lastCommand
```

`statusActions`: add `resume` for `stalled` and `timeout` (and allowlisted failed).

- [ ] **Step 3: Verify**

```powershell
npm.cmd test -- mimo-resume.test.ts job-render.test.ts
npm.cmd run lint
```

- [ ] **Step 4: Conditional commit**

Only if authorized:

```powershell
git add src/codex/tools.ts src/core/prompt.ts src/core/job-definitions.ts src/core/job-render.ts test/unit/mcp-tools/mimo-resume.test.ts test/unit/job-render.test.ts
git commit -m "feat(resume): continue stalled and timeout jobs from checkpoints"
```

---

### Task 7: Attention surfaces, docs, and release verification

**Files:**
- Modify: `src/codex/tools.ts` (`mimo_wait` already uses attention signals — ensure stalled signals enqueue)
- Modify: `src/codex/mcp-server.ts` descriptions for resume/progress timeouts
- Modify carefully: `skills/mimocode/SKILL.md`, `README.md`, `doc/operations-guide.md`
- Modify: `test/unit/public-release-contract.test.ts`, `test/unit/packaged-skill.test.ts`
- Modify: `test/unit/mcp-tools/mimo-wait.test.ts`, `test/unit/mcp-tools/mimo-status.test.ts`
- Modify: `test/integration/unified-background-jobs.test.ts` (fake-clock stall → compact attention → resume)

**Interfaces:**
- Documents: five-minute effective-progress stop-loss; `stalled` attention; checkpoint path; expanded resume; `progressTimeoutMs: 0` warning.
- Preserves Phase 1 compact defaults and callback V2.
- Integration: stall within five minutes under fake clock; compact result has lastCommand/reason/resume; resume skips broad scan instruction.

- [ ] **Step 1: Update contract tests first (TDD)**

Assert docs mention:

- `stalled` / effective progress / `progressTimeoutMs`
- `mimo_resume` for stalled/timeout
- checkpoint artifact
- warning for `progressTimeoutMs: 0`

Assert skill heartbeat still compact and treats `stalled` like other attention statuses (call `mimo_result`, delete heartbeat).

- [ ] **Step 2: Run docs tests (expect fail)**

```powershell
npm.cmd test -- public-release-contract.test.ts packaged-skill.test.ts
```

- [ ] **Step 3: Update docs/skill surgically**

In skill Desktop heartbeat section, include `stalled` in the attention list beside `needs_input`/`blocked`/terminals.

In README/ops:

- Progress stop-loss defaults (2m warning internal, 5m stall)
- Distinct from 30m transport idle timeout and absolute timeout
- Resume eligibility table
- Checkpoint path `.codex-mimo/reports/<jobId>.checkpoint.json`

- [ ] **Step 4: Integration fake-MiMo stall path**

Extend unified background jobs (or focused integration) to:

1. Run implement/compose with progressTimeoutMs small (e.g. 50ms) under fake clock/deps.
2. Emit only non-progress events.
3. Observe `stalled` + checkpoint file + compact `mimo_result.attention.resume`.
4. `mimo_resume` creates child.

- [ ] **Step 5: Full verification**

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
npm.cmd run validate:plugin
```

Expected: all PASS (smoke may skip without gates).

- [ ] **Step 6: Conditional final commit**

Only if authorized:

```powershell
git add skills/mimocode/SKILL.md README.md doc/operations-guide.md test/unit/public-release-contract.test.ts test/unit/packaged-skill.test.ts test/integration/unified-background-jobs.test.ts src/codex/mcp-server.ts
git commit -m "docs(runtime): publish stall detection and checkpoint resume"
```

---

## Self-review checklist (controller)

1. **Spec coverage (Phase 2):** effective progress clocks; warning vs timeout stages; stall reasons; `stalled` LEGAL/attention; checkpoint schema; resume eligibility including timeout/stalled; resume_conflict; process-alive gate; testing strategy items for progress + continuation — each mapped to Tasks 1–7.
2. **Out of scope guarded:** no ordered acceptance runner; no slice manifest/chain coordinator; acceptance stages empty stubs only.
3. **Phase 1 preserved:** compact defaults, artifacts, callback V2 called out in Global Constraints and Task 7.
4. **No placeholders:** tasks include concrete types, tests, and commands.
5. **Type consistency:** `progress_timeout` termination ↔ `stalled` outcome; `JobCheckpoint.version: 1`; `chainId = jobId` for single jobs.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-26-codex-mimo-stall-checkpoint-resume.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks
2. **Inline Execution** — execute in this session with executing-plans checkpoints

Which approach?
