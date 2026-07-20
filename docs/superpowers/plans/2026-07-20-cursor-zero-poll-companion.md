# Cursor Zero-Poll Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move MiMo job waiting into the Cursor `stop` hook so agents no longer poll `mimo_status`/`mimo_events`/`mimo_wait` while jobs run, and tighten MCP demotion paths for callers without companion.

**Architecture:** Companion `afterMCP` still registers watches. On `stop`, if the job is still active, the hook process block-polls `<cwd>/.codex-mimo/jobs/<jobId>.json` with intervals 30s→45s→60s until attention or wait-budget exhaustion, then emits a ≤400-char `followup_message` that only asks for `mimo_result` (or a one-shot diagnose/cancel on exhaust). MCP keeps Codex notify unchanged; Path C gets timeout diagnosis fields and a `warn` default for `mimo_events`.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest, Cursor hooks (`afterMCPExecution` / `stop`), existing job JSON under `.codex-mimo/jobs/`.

**Spec:** `docs/superpowers/specs/2026-07-20-cursor-zero-poll-companion-design.md`

## Global Constraints

- Poll schedule: **30000 → 45000 → 60000 ms**, cap **60000 ms**
- Follow-up hard cap: **≤ 400 characters**; never embed signals/JSONL/logs
- Hook config: `timeout: 1860`, `loop_limit: 5`, `failClosed: false`
- Safety pad before hook kill: **10000 ms**
- Default job timeout alignment: **1_800_000 ms**
- Env override: `CODEX_MIMO_COMPANION_WAIT_SEC`
- Exhausted watches leave the auto-wait queue (ack `exhausted` or remove + mark)
- No new MCP tool names; no Codex notify protocol changes
- Imports use `.js` extensions; `"type": "module"`
- Tests: `npm test -- <file>` via Vitest

## File map

| File | Responsibility |
|------|----------------|
| `src/companion/host-wait.ts` | Poll intervals, budget math, `awaitJobAttention` |
| `src/companion/watch.ts` | Watch state, templates, stop decision orchestration |
| `src/companion/cli.ts` | Async stdin/stdout hook entry (`after-mcp`, `stop`) |
| `hosts/cursor/hooks.json` | Template hook timeouts |
| `hosts/cursor/install.mjs` | User/project installer |
| `hosts/cursor/README.md` | Install + zero-poll trial |
| `src/codex/tools.ts` | `mimo_wait` timeout `diagnosis` / `nextAction` |
| `src/codex/tool-schemas.ts` | `minLevel` default `warn` |
| `skills/mimocode/SKILL.md` | Companion / C / Codex contracts |
| `doc/operations-guide.md` | Operator notes for Cursor path |
| `scripts/validate-plugin.mjs` | Skill checks for companion guidance |
| `test/unit/companion/host-wait.test.ts` | Host wait unit tests |
| `test/unit/companion/mimo-companion.test.ts` | Stop decision / no status nudge |
| `test/unit/mcp-tools/mimo-wait.test.ts` | Timeout diagnosis fields |
| `test/unit/mcp-tools/mimo-events.test.ts` | Default minLevel |

---

### Task 1: Host-wait primitives (budget + poll schedule)

**Files:**
- Create: `src/companion/host-wait.ts`
- Test: `test/unit/companion/host-wait.test.ts`

**Interfaces:**
- Produces:
  - `export const HOST_POLL_INTERVALS_MS = [30_000, 45_000, 60_000] as const`
  - `export const HOST_POLL_CAP_MS = 60_000`
  - `export const HOST_HOOK_SAFETY_PAD_MS = 10_000`
  - `export const DEFAULT_JOB_TIMEOUT_MS = 1_800_000`
  - `export function nextPollDelayMs(pollIndex: number): number`
  - `export function computeWaitBudgetMs(input: { nowMs: number; hookTimeoutMs: number; jobStartedAt?: string; jobTimeoutMs?: number; envWaitSec?: number }): number`
  - `export type JobStatusSnapshot = { status: string; phase?: string; startedAt?: string; requestTimeoutMs?: number }`
  - `export function readJobStatusSnapshot(cwd: string, jobId: string): JobStatusSnapshot | undefined`
  - `export type HostWaitOutcome = { type: "attention"; status: string } | { type: "exhausted"; status: string; waitedMs: number }`
  - `export async function awaitJobAttention(options: { cwd: string; jobId: string; budgetMs: number; now?: () => number; sleep?: (ms: number) => Promise<void>; readJob?: typeof readJobStatusSnapshot; isAttention?: (status: string) => boolean }): Promise<HostWaitOutcome>`

- [ ] **Step 1: Write failing tests for poll delay and budget**

Create `test/unit/companion/host-wait.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  awaitJobAttention,
  computeWaitBudgetMs,
  nextPollDelayMs,
  HOST_POLL_INTERVALS_MS,
  HOST_HOOK_SAFETY_PAD_MS
} from "../../../src/companion/host-wait.js";

describe("host-wait primitives", () => {
  it("uses 30s → 45s → 60s poll delays", () => {
    expect(nextPollDelayMs(0)).toBe(30_000);
    expect(nextPollDelayMs(1)).toBe(45_000);
    expect(nextPollDelayMs(2)).toBe(60_000);
    expect(nextPollDelayMs(99)).toBe(60_000);
    expect([...HOST_POLL_INTERVALS_MS]).toEqual([30_000, 45_000, 60_000]);
  });

  it("computes budget as min(job remaining, env, hook-pad)", () => {
    const nowMs = Date.parse("2026-07-20T00:10:00.000Z");
    const budget = computeWaitBudgetMs({
      nowMs,
      hookTimeoutMs: 1_860_000,
      jobStartedAt: "2026-07-20T00:00:00.000Z",
      jobTimeoutMs: 1_800_000,
      envWaitSec: 120
    });
    // job remaining = 1_800_000 - 600_000 = 1_200_000
    // env = 120_000
    // hook-pad = 1_860_000 - 10_000 = 1_850_000
    expect(budget).toBe(120_000);
    expect(HOST_HOOK_SAFETY_PAD_MS).toBe(10_000);
  });

  it("awaits until attention with injectable clock", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "host-wait-"));
    const jobDir = path.join(cwd, ".codex-mimo", "jobs");
    fs.mkdirSync(jobDir, { recursive: true });
    const jobFile = path.join(jobDir, "j1.json");
    fs.writeFileSync(jobFile, JSON.stringify({
      id: "j1",
      status: "running",
      startedAt: "2026-07-20T00:00:00.000Z",
      request: { timeoutMs: 1_800_000 }
    }));

    let now = 0;
    const sleeps: number[] = [];
    const outcome = await awaitJobAttention({
      cwd,
      jobId: "j1",
      budgetMs: 90_000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
        if (sleeps.length === 1) {
          fs.writeFileSync(jobFile, JSON.stringify({
            id: "j1",
            status: "completed",
            startedAt: "2026-07-20T00:00:00.000Z",
            request: { timeoutMs: 1_800_000 }
          }));
        }
      }
    });

    expect(sleeps[0]).toBe(30_000);
    expect(outcome).toEqual({ type: "attention", status: "completed" });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("returns exhausted when budget elapses while still active", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "host-wait-ex-"));
    const jobDir = path.join(cwd, ".codex-mimo", "jobs");
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, "j2.json"), JSON.stringify({
      id: "j2", status: "running", startedAt: "2026-07-20T00:00:00.000Z", request: {}
    }));
    let now = 0;
    const outcome = await awaitJobAttention({
      cwd,
      jobId: "j2",
      budgetMs: 50_000,
      now: () => now,
      sleep: async (ms) => { now += ms; }
    });
    expect(outcome.type).toBe("exhausted");
    if (outcome.type === "exhausted") {
      expect(outcome.status).toBe("running");
      expect(outcome.waitedMs).toBeGreaterThan(0);
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/unit/companion/host-wait.test.ts`

Expected: FAIL (module not found / exports missing)

- [ ] **Step 3: Implement `src/companion/host-wait.ts`**

```ts
import fs from "node:fs";
import path from "node:path";

export const HOST_POLL_INTERVALS_MS = [30_000, 45_000, 60_000] as const;
export const HOST_POLL_CAP_MS = 60_000;
export const HOST_HOOK_SAFETY_PAD_MS = 10_000;
export const DEFAULT_JOB_TIMEOUT_MS = 1_800_000;

const ATTENTION = new Set([
  "needs_input", "blocked", "completed", "failed", "cancelled", "timeout"
]);

export type JobStatusSnapshot = {
  status: string;
  phase?: string;
  startedAt?: string;
  requestTimeoutMs?: number;
};

export type HostWaitOutcome =
  | { type: "attention"; status: string }
  | { type: "exhausted"; status: string; waitedMs: number };

export function nextPollDelayMs(pollIndex: number): number {
  if (pollIndex < 0) return HOST_POLL_INTERVALS_MS[0]!;
  if (pollIndex >= HOST_POLL_INTERVALS_MS.length) return HOST_POLL_CAP_MS;
  return HOST_POLL_INTERVALS_MS[pollIndex]!;
}

export function computeWaitBudgetMs(input: {
  nowMs: number;
  hookTimeoutMs: number;
  jobStartedAt?: string;
  jobTimeoutMs?: number;
  envWaitSec?: number;
}): number {
  const hookBudget = Math.max(0, input.hookTimeoutMs - HOST_HOOK_SAFETY_PAD_MS);
  const jobTimeout = input.jobTimeoutMs && input.jobTimeoutMs > 0
    ? input.jobTimeoutMs
    : DEFAULT_JOB_TIMEOUT_MS;
  const started = input.jobStartedAt ? Date.parse(input.jobStartedAt) : Number.NaN;
  const jobRemaining = Number.isFinite(started)
    ? Math.max(0, started + jobTimeout - input.nowMs)
    : jobTimeout;
  const envBudget = typeof input.envWaitSec === "number" && Number.isFinite(input.envWaitSec) && input.envWaitSec > 0
    ? input.envWaitSec * 1000
    : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(hookBudget, jobRemaining, envBudget));
}

export function readJobStatusSnapshot(cwd: string, jobId: string): JobStatusSnapshot | undefined {
  const file = path.join(cwd, ".codex-mimo", "jobs", `${jobId}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof raw.status !== "string") return undefined;
    const request = raw.request && typeof raw.request === "object" && !Array.isArray(raw.request)
      ? raw.request as Record<string, unknown>
      : {};
    const requestTimeoutMs = typeof request.timeoutMs === "number" && Number.isFinite(request.timeoutMs)
      ? request.timeoutMs
      : undefined;
    return {
      status: raw.status,
      ...(typeof raw.phase === "string" ? { phase: raw.phase } : {}),
      ...(typeof raw.startedAt === "string" ? { startedAt: raw.startedAt } : {}),
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs })
    };
  } catch {
    return undefined;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function awaitJobAttention(options: {
  cwd: string;
  jobId: string;
  budgetMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readJob?: typeof readJobStatusSnapshot;
  isAttention?: (status: string) => boolean;
}): Promise<HostWaitOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const readJob = options.readJob ?? readJobStatusSnapshot;
  const isAttention = options.isAttention ?? ((status) => ATTENTION.has(status));
  const startedAt = now();
  const deadline = startedAt + Math.max(0, options.budgetMs);
  let pollIndex = 0;
  let lastStatus = "running";

  for (;;) {
    const snap = readJob(options.cwd, options.jobId);
    if (snap) lastStatus = snap.status;
    if (snap && isAttention(snap.status)) {
      return { type: "attention", status: snap.status };
    }
    const t = now();
    if (t >= deadline) {
      return { type: "exhausted", status: lastStatus, waitedMs: Math.max(0, t - startedAt) };
    }
    const delay = Math.min(nextPollDelayMs(pollIndex), Math.max(1, deadline - t));
    pollIndex += 1;
    await sleep(delay);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/unit/companion/host-wait.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/companion/host-wait.ts test/unit/companion/host-wait.test.ts
git commit -m "feat(companion): add host-side job wait primitives"
```

---

### Task 2: Stop decision uses host wait (no active status nudge)

**Files:**
- Modify: `src/companion/watch.ts`
- Modify: `test/unit/companion/mimo-companion.test.ts`
- Consumes: Task 1 exports from `host-wait.ts`

**Interfaces:**
- Produces:
  - `export const MAX_FOLLOWUP_CHARS = 400`
  - `export function formatAttentionFollowup(cwd: string, jobId: string, status: string): string`
  - `export function formatExhaustedFollowup(jobId: string, status: string): string`
  - `export async function decideStopFollowup(state, options): Promise<StopDecision>` (async)
  - `export async function handleStop(...): Promise<{ output; nextState }>` (async)
  - On exhaust: remove watch; set `acked[key] = { status: "exhausted", ackedAt }`

- [ ] **Step 1: Rewrite failing/updated companion tests**

Replace the test `"polls active jobs until loop limit"` with host-wait behavior tests. Keep abort / attention / ack tests, but make `decideStopFollowup` / `handleStop` async (`await`).

Add/replace cases in `test/unit/companion/mimo-companion.test.ts`:

```ts
it("blocks on active jobs then asks for mimo_result when completed", async () => {
  const cwd = tempDir();
  const jobFile = path.join(cwd, ".codex-mimo", "jobs", "plan-2.json");
  writeJob(cwd, {
    id: "plan-2",
    status: "running",
    startedAt: "2026-07-20T00:00:00.000Z",
    request: { timeoutMs: 1_800_000 },
    updatedAt: "2026-07-20T01:00:00.000Z"
  });
  const state = upsertWatch(emptyState(), {
    cwd, jobId: "plan-2", kind: "plan", createdAt: "2026-07-20T00:00:00.000Z"
  });
  let now = Date.parse("2026-07-20T01:00:00.000Z");
  const decided = await decideStopFollowup(state, {
    hookStatus: "completed",
    now: () => new Date(now),
    hookTimeoutMs: 1_860_000,
    sleep: async (ms) => {
      now += ms;
      fs.writeFileSync(jobFile, `${JSON.stringify({
        id: "plan-2",
        status: "completed",
        startedAt: "2026-07-20T00:00:00.000Z",
        request: { timeoutMs: 1_800_000 }
      }, null, 2)}\n`);
    }
  });
  expect(decided.followup).toContain("mimo_result");
  expect(decided.followup).not.toMatch(/mimo_status|mimo_wait/);
  expect(decided.followup!.length).toBeLessThanOrEqual(400);
});

it("exhausts wait budget and leaves the auto-wait queue", async () => {
  const cwd = tempDir();
  writeJob(cwd, {
    id: "plan-ex",
    status: "running",
    startedAt: "2026-07-20T00:00:00.000Z",
    request: { timeoutMs: 1_800_000 }
  });
  const state = upsertWatch(emptyState(), {
    cwd, jobId: "plan-ex", kind: "plan", createdAt: "2026-07-20T00:00:00.000Z"
  });
  let now = Date.parse("2026-07-20T00:00:00.000Z");
  const decided = await decideStopFollowup(state, {
    hookStatus: "completed",
    now: () => new Date(now),
    hookTimeoutMs: 1_860_000,
    envWaitSec: 50,
    sleep: async (ms) => { now += ms; }
  });
  expect(decided.followup).toMatch(/still running|host wait/i);
  expect(decided.followup).toContain("mimo_status");
  expect(decided.followup).not.toMatch(/mimo_wait/);
  expect(decided.nextState.watches.find((w) => w.jobId === "plan-ex")).toBeUndefined();
  expect(decided.nextState.acked[watchKey(cwd, "plan-ex")]?.status).toBe("exhausted");
});
```

Update existing async call sites: every `decideStopFollowup` / `handleStop` in this file must `await`.

Attention template test should assert the new shorter copy (`MiMo job` …) and `length <= 400`.

- [ ] **Step 2: Run companion tests — expect failures on active-path assertions**

Run: `npm test -- test/unit/companion/mimo-companion.test.ts`

Expected: FAIL (sync vs async and/or still nudges `mimo_status` on active)

- [ ] **Step 3: Implement async stop decision in `watch.ts`**

Key changes (keep existing helpers; replace `decideStopFollowup` / `handleStop`):

```ts
import {
  awaitJobAttention,
  computeWaitBudgetMs,
  readJobStatusSnapshot
} from "./host-wait.js";

export const MAX_FOLLOWUP_CHARS = 400;

export function formatAttentionFollowup(cwd: string, jobId: string, status: string): string {
  const text = [
    `MiMo job ${jobId} needs attention (status=${status}).`,
    `Call mimo_result with {"cwd":${JSON.stringify(cwd)},"jobId":${JSON.stringify(jobId)}}.`,
    "Summarize for the user; do not invent outcomes. If needs_input/blocked, ask user then mimo_resume."
  ].join(" ");
  return text.slice(0, MAX_FOLLOWUP_CHARS);
}

export function formatExhaustedFollowup(jobId: string, status: string): string {
  const text = [
    `MiMo job ${jobId} still ${status} after host wait.`,
    "Call mimo_status once OR mimo_cancel. Do not loop wait/events. Report to user."
  ].join(" ");
  return text.slice(0, MAX_FOLLOWUP_CHARS);
}

export async function decideStopFollowup(
  state: CompanionWatchState,
  options: {
    now?: Date | (() => Date);
    hookStatus?: string;
    hookTimeoutMs?: number;
    envWaitSec?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<StopDecision> {
  const nowFn = typeof options.now === "function"
    ? options.now
    : () => options.now ?? new Date();
  const status = options.hookStatus ?? "completed";
  if (status === "aborted") {
    return { followup: undefined, nextState: state };
  }

  // 1) Prefer immediate unacked attention (no block)
  // 2) Else pick first active watch (FIFO), compute budget, awaitJobAttention
  // 3) attention → formatAttentionFollowup + ack status
  // 4) exhausted → formatExhaustedFollowup + remove watch + ack "exhausted"
  // Remove maxActiveLoops / mimo_status nudge entirely
}
```

`handleStop` becomes async and forwards `hookTimeoutMs` / `envWaitSec` / `sleep` from options. Default `hookTimeoutMs` to `1_860_000`. Default `envWaitSec` from `Number(process.env.CODEX_MIMO_COMPANION_WAIT_SEC)` when finite and > 0.

Extend `CompanionWatch` with optional `waitStartedAt?`, `lastPolledAt?`, `exhaustedAt?` (set when useful; not required in follow-up).

- [ ] **Step 4: Run companion tests**

Run: `npm test -- test/unit/companion/mimo-companion.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/companion/watch.ts test/unit/companion/mimo-companion.test.ts
git commit -m "feat(companion): block in stop hook instead of status polling"
```

---

### Task 3: Async companion CLI

**Files:**
- Modify: `src/companion/cli.ts`

**Interfaces:**
- Consumes: async `handleStop` / sync `handleAfterMcp`
- Produces: CLI still prints one JSON line on stdout after wait completes

- [ ] **Step 1: Update `cli.ts` stop branch to await**

```ts
if (mode === "stop") {
  const hookTimeoutSec = Number(process.env.CODEX_MIMO_COMPANION_HOOK_TIMEOUT_SEC ?? "1860");
  const result = await handleStop(payload, state, {
    hookTimeoutMs: (Number.isFinite(hookTimeoutSec) && hookTimeoutSec > 0 ? hookTimeoutSec : 1860) * 1000
  });
  writeState(file, result.nextState);
  writeStdout(result.output);
  return;
}
```

Keep `after-mcp` sync. Ensure `main` remains async (already `await main(...)`).

- [ ] **Step 2: Build**

Run: `npm run build`

Expected: `dist/companion/cli.js` compiles with no errors

- [ ] **Step 3: Commit**

```bash
git add src/companion/cli.ts
git commit -m "feat(companion): await host wait in stop CLI"
```

---

### Task 4: Cursor host config + README (P1)

**Files:**
- Modify: `hosts/cursor/hooks.json`
- Modify: `hosts/cursor/install.mjs`
- Modify: `hosts/cursor/README.md`

- [ ] **Step 1: Update hooks template**

`hosts/cursor/hooks.json` stop hook:

```json
"stop": [
  {
    "command": "node ./dist/companion/cli.js stop",
    "loop_limit": 5,
    "timeout": 1860
  }
]
```

Mirror in `install.mjs` `hookConfig()` (`timeout: 1860`, `loop_limit: 5`). Do not set `failClosed`.

- [ ] **Step 2: Rewrite README trial for zero-poll**

Document:

1. Build + `node hosts/cursor/install.mjs --user` (or `--project`)
2. Reload Cursor hooks
3. Ask agent to call `mimo_plan` then stop — agent must **not** call status/wait while running
4. Hook may run for a long time (expected); then auto follow-up asks only for `mimo_result`
5. Optional: `CODEX_MIMO_COMPANION_WAIT_SEC=60` for a short exhausted diagnostic
6. Inspect `~/.codex-mimo/companion-watch.json` if nothing happens

- [ ] **Step 3: Commit**

```bash
git add hosts/cursor/hooks.json hosts/cursor/install.mjs hosts/cursor/README.md
git commit -m "chore(cursor): raise stop hook timeout for host waits"
```

---

### Task 5: MCP `mimo_wait` timeout diagnosis (P2)

**Files:**
- Modify: `src/codex/tools.ts` (`mimoWait` return on timeout)
- Modify: `test/unit/mcp-tools/mimo-wait.test.ts`

**Interfaces:**
- Produces timeout fields: `diagnosis: string`, `nextAction: "status_once" | "cancel" | "stop"`
- On timeout: `signals` remains `[]` (already true)

- [ ] **Step 1: Extend timeout test**

In `test/unit/mcp-tools/mimo-wait.test.ts`, update `"returns empty signals and current status on timeout without a heartbeat"`:

```ts
expect(result).toMatchObject({
  status: "running",
  phase: "reviewing",
  timedOut: true,
  waitedMs: 2_500,
  signals: [],
  diagnosis: expect.any(String),
  nextAction: "status_once"
});
expect(result.diagnosis.length).toBeGreaterThan(0);
expect(result.diagnosis.length).toBeLessThanOrEqual(160);
```

- [ ] **Step 2: Run test — expect fail on missing fields**

Run: `npm test -- test/unit/mcp-tools/mimo-wait.test.ts`

Expected: FAIL (diagnosis/nextAction undefined)

- [ ] **Step 3: Implement timeout fields in `mimoWait`**

When `result.signals.length === 0` (timed out), add:

```ts
diagnosis: publicProgressSummary({
  type: "job",
  status: job.status,
  ...(job.phase ? { phase: job.phase } : {})
}),
nextAction: job.status === "queued" || job.status === "running" ? "status_once" : "stop"
```

Import `publicProgressSummary` from `../core/public-summary.js` if not already imported in `tools.ts`.

- [ ] **Step 4: Run wait tests**

Run: `npm test -- test/unit/mcp-tools/mimo-wait.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/codex/tools.ts test/unit/mcp-tools/mimo-wait.test.ts
git commit -m "feat(mcp): add compact diagnosis on mimo_wait timeout"
```

---

### Task 6: Default `mimo_events` minLevel to `warn` (P2)

**Files:**
- Modify: `src/codex/tool-schemas.ts`
- Modify: `test/unit/mcp-tools/mimo-events.test.ts` (add or adjust default assertion)

- [ ] **Step 1: Add default-level test**

```ts
it("defaults minLevel to warn", async () => {
  const cwd = tempWorkspace(); // use existing helper in file
  const job = createJobStore(cwd).create({ kind: "plan", task: "Plan", request: {} });
  appendJobSignal(job.signalsFile, {
    jobId: job.id, kind: "milestone", level: "info", summary: "info only"
  });
  appendJobSignal(job.signalsFile, {
    jobId: job.id, kind: "failed", level: "error", status: "failed", summary: "boom"
  });
  const result = await mimoEvents({ cwd, jobId: job.id });
  expect(result.signals.map((s) => s.level)).toEqual(["error"]);
});
```

(Adapt helper names to the existing events test file.)

- [ ] **Step 2: Run — expect fail if default still debug**

Run: `npm test -- test/unit/mcp-tools/mimo-events.test.ts`

Expected: FAIL (info signal still returned) or adjust expectation once default changes

- [ ] **Step 3: Change schema default**

In `src/codex/tool-schemas.ts`:

```ts
minLevel: z.enum(["debug", "info", "warn", "error"]).default("warn")
```

Note: `JobWaitInput` extends `JobEventsInput`, so wait also defaults to `warn` (desired for demotion).

- [ ] **Step 4: Fix any tests that assumed default `debug` without passing `minLevel`**

Run: `npm test -- test/unit/mcp-tools/`

Expected: PASS (update call sites to `minLevel: "debug"` where full signal lists are required)

- [ ] **Step 5: Commit**

```bash
git add src/codex/tool-schemas.ts test/unit/mcp-tools/mimo-events.test.ts test/unit/mcp-tools/mimo-wait.test.ts
git commit -m "fix(mcp): default event minLevel to warn"
```

---

### Task 7: Skill, operations guide, validator (P3)

**Files:**
- Modify: `skills/mimocode/SKILL.md`
- Modify: `doc/operations-guide.md`
- Modify: `scripts/validate-plugin.mjs`

- [ ] **Step 1: Rewrite skill callback section for three paths**

Replace/extend "Callback-Driven Workflow" so it includes:

1. **Cursor + companion (recommended):** work tool → report receipt → stop; on follow-up only `mimo_result`; never status/events/wait while running.
2. **Cursor without companion:** work tool → report jobId → stop; if user insists, at most one `mimo_wait`, then at most one `mimo_status`; never loop.
3. **Codex notify:** keep existing callback-driven bullets.

Explicitly forbid instructing agents to poll/loop on `mimo_wait` (validator already enforces).

- [ ] **Step 2: Operations guide**

Add a short "Cursor companion zero-poll" subsection: long hook timeout is expected; exhausted watch leaves queue; env `CODEX_MIMO_COMPANION_WAIT_SEC`; diagnosis tools only for explicit demotion.

- [ ] **Step 3: Strengthen validator**

In `validateSkill`, after the existing anti-poll check, add:

```js
if (!/companion/i.test(parsed.body) || !/mimo_result/i.test(parsed.body)) {
  errors.push(`${relativeSkillFile} must document companion wake path using mimo_result`);
}
if (!/without companion|no companion|without the companion/i.test(parsed.body)) {
  errors.push(`${relativeSkillFile} must document the no-companion demotion path`);
}
```

- [ ] **Step 4: Validate**

Run: `npm run validate:plugin`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skills/mimocode/SKILL.md doc/operations-guide.md scripts/validate-plugin.mjs
git commit -m "docs: document Cursor zero-poll and demotion paths"
```

---

### Task 8: Full regression + manual checklist (P4)

**Files:**
- Modify: `hosts/cursor/README.md` (checklist already mostly done; ensure zero-intermediate-tools language)

- [ ] **Step 1: Run full automated suite**

Run:

```bash
npm run build
npm test
npm run lint
npm run validate:plugin
```

Expected: all PASS

- [ ] **Step 2: Manual checklist (operator)**

When a local MiMo + Cursor is available:

1. `npm run build && node hosts/cursor/install.mjs --user`
2. Reload hooks
3. In a git workspace, agent runs `mimo_plan` with a short task
4. Confirm: no `mimo_status` / `mimo_events` / `mimo_wait` between receipt and attention follow-up
5. Confirm: follow-up triggers one `mimo_result`
6. Optional: `CODEX_MIMO_COMPANION_WAIT_SEC=60` with a long task → one exhausted follow-up; second stop does not block another full wait for same job

Record any failures as follow-up fixes in the same branch (multi-job FIFO already required in Task 2: first active watch only).

- [ ] **Step 3: Commit any checklist/doc tweaks**

```bash
git add hosts/cursor/README.md
git commit -m "docs(cursor): finalize zero-poll acceptance notes"
```

(Skip empty commit if nothing changed.)

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Host blocking wait in stop hook | 1–3 |
| Poll 30→45→60s | 1 |
| Budget = min(job, env, hook−pad) | 1–2 |
| Attention follow-up → `mimo_result` only | 2 |
| Exhaust → dequeue / ack exhausted | 2 |
| hooks timeout 1860 / loop_limit 5 | 4 |
| `mimo_wait` diagnosis + nextAction | 5 |
| events default `warn` | 6 |
| Skill three-path + validator | 7 |
| Manual zero-poll acceptance | 8 |
| Codex notify unchanged | (no task — explicit non-touch) |
| No `mimo_diagnose` tool | (no task — YAGNI) |

## Self-review notes

- No TBD placeholders in task steps.
- `decideStopFollowup` becomes async in Task 2; CLI awaits in Task 3 — order must not reverse.
- `JobWaitInput` inherits `minLevel` default change in Task 6; wait tests that need debug signals must pass `minLevel: "debug"` explicitly.
