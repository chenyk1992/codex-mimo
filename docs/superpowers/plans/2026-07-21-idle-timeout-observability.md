# Idle Timeout and Job Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect MiMo JSONL silence, expose live stall fields on `mimo_status`, and idle-stop jobs as `timeout`/`idle_timeout` so Codex notify can callback.

**Architecture:** Extend `runMimoCliStreaming` with an idle clock (silence since last stdout line) that terminates the process tree like absolute timeout but with `terminationReason: "idle_timeout"`. The worker persists live observation fields on each line, maps idle termination through `classifyRunOutcome` to `timeout` + `idle_timeout`, and renders `idleMs` / `lastEventAt` / `lastTool` / `processAlive` on status. Absolute `timeoutMs` stays unchanged; whichever fires first wins.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod, Vitest, existing job store / transition / notify outbox.

**Spec:** `docs/superpowers/specs/2026-07-21-idle-timeout-observability-design.md`

## Global Constraints

- Idle default: **`1_800_000` ms (30 minutes)** when `idleTimeoutMs` omitted
- `idleTimeoutMs: 0` disables idle stop-loss; absolute `timeoutMs` still applies
- Idle stop-loss terminal: **`status: "timeout"`**, **`errorCode: "idle_timeout"`**
- Absolute process timeout keeps **`errorCode: "timeout"`** (via `terminationReason: "process_timeout"`)
- Idle clock = time since last stdout JSONL line; set `lastEventAt` on process start
- Idle poll interval ≈ **5000 ms**
- Public summary for `idle_timeout` must stay distinguishable (not scrubbed to generic failed)
- Receipt shape for queued work tools unchanged
- Imports use `.js` extensions; `"type": "module"`
- Tests: `npm test -- <file>` via Vitest

## File map

| File | Responsibility |
|------|----------------|
| `src/mimo/streaming-runner.ts` | `idleTimeoutMs`, `terminationReason: "idle_timeout"`, idle timer |
| `src/core/job-outcome.ts` | Map `idle_timeout` termination → job outcome |
| `src/core/public-summary.ts` | Known operator summary for `idle_timeout` |
| `src/core/job-definitions.ts` | Request schema `idleTimeoutMs` |
| `src/codex/tool-schemas.ts` | MCP input `idleTimeoutMs` |
| `src/core/jobs.ts` | `JobRecord` / `JobStatusResult` observation fields |
| `src/core/job-store.ts` | Persist/validate observation fields |
| `src/core/job-transition.ts` | `updateRunningJobObservation` |
| `src/core/job-worker.ts` | Wire idle options + live observation updates |
| `src/core/job-render.ts` | Status fields including computed `idleMs` / `processAlive` |
| `src/cli/commands.ts` | Optional `--idle-timeout-ms` for work commands |
| `skills/mimocode/SKILL.md` | Document idle timeout + callback behavior |
| `doc/operations-guide.md` | Operator notes for stalls / notify |
| `test/unit/mimo-streaming-runner.test.ts` | Idle kill tests |
| `test/unit/core/job-outcome.test.ts` | `idle_timeout` outcome |
| `test/unit/core/public-summary.test.ts` or existing summary tests | Distinct summary |
| `test/unit/job-render` / status tests | Live fields |

---

### Task 1: Streaming runner idle termination

**Files:**
- Modify: `src/mimo/streaming-runner.ts`
- Test: `test/unit/mimo-streaming-runner.test.ts`

**Interfaces:**
- Consumes: existing `runMimoCliStreaming`, `terminateProcessTree`
- Produces:
  - `TerminationReason` includes `"idle_timeout"`
  - `StreamingRunOptions.idleTimeoutMs?: number` — `undefined`/omit = no idle kill; `> 0` enables; treat `0` as disabled
  - On idle kill: `terminationReason: "idle_timeout"`, `exitCode: 124` (same as process timeout)

- [ ] **Step 1: Write failing idle-timeout test**

Add to `test/unit/mimo-streaming-runner.test.ts`:

```ts
  it("terminates the process when idleTimeoutMs elapses without stdout lines", async () => {
    let killedPid: number | null | undefined;
    const result = await runMimoCliStreaming("E:/project/app", ["run"], {
      idleTimeoutMs: 30,
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
          pid: number;
          kill: () => boolean;
        };
        child.pid = 4242;
        // Never emits lines; stays open until terminated.
        child.stdout = new Readable({ read() {} });
        child.stderr = new Readable({ read() {} });
        child.kill = () => true;
        return child;
      },
      terminateProcessTree: (pid, child) => {
        killedPid = pid;
        queueMicrotask(() => child.emit("close", null));
      }
    });

    expect(killedPid).toBe(4242);
    expect(result.exitCode).toBe(124);
    expect(result.terminationReason).toBe("idle_timeout");
  });

  it("does not idle-kill when idleTimeoutMs is 0", async () => {
    let terminateCalled = false;
    const childRef = {
      emitClose: null as null | (() => void)
    };
    const runPromise = runMimoCliStreaming("E:/project/app", ["run"], {
      idleTimeoutMs: 0,
      timeoutMs: 80,
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
          pid: number;
          kill: () => boolean;
        };
        child.pid = 4243;
        child.stdout = new Readable({ read() {} });
        child.stderr = new Readable({ read() {} });
        child.kill = () => true;
        childRef.emitClose = () => child.emit("close", null);
        return child;
      },
      terminateProcessTree: (_pid, child) => {
        terminateCalled = true;
        queueMicrotask(() => child.emit("close", null));
      }
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(terminateCalled).toBe(false);
    const result = await runPromise;
    expect(result.terminationReason).toBe("process_timeout");
  });

  it("resets idle clock when stdout lines arrive", async () => {
    let terminateReason: string | undefined;
    const result = await runMimoCliStreaming("E:/project/app", ["run"], {
      idleTimeoutMs: 80,
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
          pid: number;
          kill: () => boolean;
        };
        child.pid = 4244;
        const stdout = new Readable({ read() {} });
        child.stdout = stdout;
        child.stderr = new Readable({ read() {} });
        child.kill = () => true;
        queueMicrotask(() => {
          stdout.push('{"type":"text","sessionID":"ses_x"}\n');
          setTimeout(() => {
            stdout.push('{"type":"text","sessionID":"ses_x"}\n');
            setTimeout(() => {
              stdout.push(null);
              child.emit("close", 0);
            }, 40);
          }, 40);
        });
        return child;
      },
      terminateProcessTree: (_pid, child) => {
        terminateReason = "idle";
        child.emit("close", null);
      }
    });
    expect(terminateReason).toBeUndefined();
    expect(result.terminationReason).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- mimo-streaming-runner.test.ts`

Expected: FAIL — `idleTimeoutMs` / `idle_timeout` not implemented.

- [ ] **Step 3: Implement idle timer in streaming-runner**

In `src/mimo/streaming-runner.ts`:

1. Extend `TerminationReason`:
```ts
export type TerminationReason =
  | "process_timeout"
  | "idle_timeout"
  | "host_abort"
  | "user_cancelled";
```

2. Add to `StreamingRunOptions`:
```ts
  idleTimeoutMs?: number;
  idleCheckIntervalMs?: number;
```

3. Inside `runMimoCliStreaming`, after creating the child / before racing exit:
   - `let lastActivityAt = Date.now()`
   - On each stdout line handler, set `lastActivityAt = Date.now()` (in addition to existing `onLine`)
   - If `options.idleTimeoutMs` is a finite number `> 0`, start `setInterval` every `options.idleCheckIntervalMs ?? 5_000` (use a smaller interval in tests by passing `idleCheckIntervalMs: 10`):
     - if `Date.now() - lastActivityAt >= options.idleTimeoutMs`, call `requestTermination("idle_timeout")` and clear the interval
   - Clear the interval in `clearTerminationTimers` / `finally`

Keep absolute `timeoutMs` timer unchanged; both may be armed; first termination wins.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- mimo-streaming-runner.test.ts`

Expected: PASS (adjust timing/helpers if flaky; prefer injectable `idleCheckIntervalMs` and short `idleTimeoutMs`).

- [ ] **Step 5: Commit**

```bash
git add src/mimo/streaming-runner.ts test/unit/mimo-streaming-runner.test.ts
git commit -m "$(cat <<'EOF'
feat(mimo): idle-timeout kill when JSONL stdout goes silent

EOF
)"
```

---

### Task 2: Outcome mapping and public summary

**Files:**
- Modify: `src/core/job-outcome.ts`
- Modify: `src/core/public-summary.ts`
- Test: `test/unit/core/job-outcome.test.ts` (create if missing patterns; otherwise extend)
- Test: existing public-summary tests if present; else add `test/unit/core/public-summary.test.ts`

**Interfaces:**
- Consumes: `RunEvidence.terminationReason` (extended)
- Produces:
  - `classifyRunOutcome` → `{ status: "timeout", errorCode: "idle_timeout", summary/error: "MiMoCode job idle-timed out." }` when `terminationReason === "idle_timeout"`
  - `KNOWN_OPERATOR_ERROR_SUMMARIES.idle_timeout = "MiMoCode job idle-timed out."`

- [ ] **Step 1: Write failing outcome + summary tests**

```ts
// job-outcome
expect(classifyRunOutcome({
  exitCode: 124,
  terminationReason: "idle_timeout",
  verification: [],
  finalText: ""
})).toMatchObject({
  status: "timeout",
  errorCode: "idle_timeout",
  summary: "MiMoCode job idle-timed out.",
  error: "MiMoCode job idle-timed out."
});

// Ensure absolute timeout still uses errorCode "timeout"
expect(classifyRunOutcome({
  exitCode: 124,
  terminationReason: "process_timeout",
  verification: [],
  finalText: ""
}).errorCode).toBe("timeout");

// public-summary
expect(publicProgressSummary({
  type: "job",
  status: "timeout",
  errorCode: "idle_timeout"
})).toBe("MiMoCode job idle-timed out.");
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npm test -- job-outcome.test.ts public-summary.test.ts`

- [ ] **Step 3: Implement mapping**

In `classifyRunOutcome`, **before** the `process_timeout` branch:

```ts
  if (evidence.terminationReason === "idle_timeout") {
    return failureOutcome(
      "timeout",
      "MiMoCode job idle-timed out.",
      "idle_timeout",
      common
    );
  }
```

In `public-summary.ts` `KNOWN_OPERATOR_ERROR_SUMMARIES`:

```ts
  idle_timeout: "MiMoCode job idle-timed out.",
```

Also handle signal-type failed/timeout summaries if `errorCode` is passed for `timeout` status signals (job transition already passes `errorCode` into `publicProgressSummary`).

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/core/job-outcome.ts src/core/public-summary.ts test/unit/core/job-outcome.test.ts test/unit/core/public-summary.test.ts
git commit -m "$(cat <<'EOF'
feat(core): map idle_timeout termination to distinct timeout outcome

EOF
)"
```

---

### Task 3: Request schema `idleTimeoutMs` (CLI + MCP + job definitions)

**Files:**
- Modify: `src/core/job-definitions.ts` (`CommonRequestSchema`)
- Modify: `src/codex/tool-schemas.ts` (`JobOptionsSchema`)
- Modify: `src/cli/commands.ts` (parse `--idle-timeout-ms`, allow `0`)
- Test: `test/unit/tool-schemas.test.ts` and/or compose/job request tests

**Interfaces:**
- Produces: every work request may include `idleTimeoutMs: number` with default `1_800_000`; `0` allowed meaning disabled
- Zod: `z.number().int().min(0).default(1_800_000)` on common schemas

- [ ] **Step 1: Write failing schema tests**

Assert `JobOptionsSchema` / plan-or-implement parse:
- omitted → `idleTimeoutMs === 1_800_000`
- `0` accepted
- negative rejected

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement schema + CLI flag**

`CommonRequestSchema` and `JobOptionsSchema`:

```ts
idleTimeoutMs: z.number().int().min(0).default(1_800_000),
```

CLI: read optional integer including zero (extend `takeOptionalInteger` usage or add allow-zero helper). Pass through on work command common options.

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/core/job-definitions.ts src/codex/tool-schemas.ts src/cli/commands.ts test/unit/tool-schemas.test.ts
git commit -m "$(cat <<'EOF'
feat: accept idleTimeoutMs on work tool requests

EOF
)"
```

---

### Task 4: Persist live observation fields + worker wiring

**Files:**
- Modify: `src/core/jobs.ts` (`JobRecord` optional fields)
- Modify: `src/core/job-store.ts` (validate optional fields; ensure create seeds `idleTimeoutMs` from request when available)
- Modify: `src/core/job-transition.ts` (add `updateRunningJobObservation`)
- Modify: `src/core/job-worker.ts` (pass `idleTimeoutMs`, refresh observation on lines, set `lastEventAt` on start)
- Modify: `src/compose/events.ts` only if needed for tool-name extraction helpers (prefer reuse `normalizeMimoEvent` / existing parsers)
- Test: unit tests for `updateRunningJobObservation` and worker idle wiring (mock streaming runner)

**Interfaces:**
- Produces on `JobRecord` (optional):
  - `lastEventAt?: string`
  - `lastTool?: string`
  - `idleTimeoutMs?: number` (effective budget copied from request at create or first run)
- Produces:
```ts
export async function updateRunningJobObservation(
  cwd: string,
  jobId: string,
  patch: {
    lastEventAt?: string;
    lastTool?: string;
    sessionId?: string | null;
    idleTimeoutMs?: number;
  }
): Promise<JobRecord>;
```
- Worker `runMimoCliStreaming` options include:
  - `timeoutMs: readTimeout(request)`
  - `idleTimeoutMs: readIdleTimeout(request)` where `0` stays `0`, omitted defaults to `1_800_000`
  - `onStart`: set `lastEventAt` now via observation update
  - `onLine`: parse session + tool; update observation (best-effort; do not throw into stream)

- [ ] **Step 1: Write failing store/transition tests**

- Observation patch updates `lastEventAt` / `sessionId` / `lastTool` while `running`
- Non-running job ignores or no-ops safely
- `isJobRecord` accepts new optional fields

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement types, validation, `updateRunningJobObservation`**

Mirror `updateRunningJobProcess` lock + `updateJobAuthoritative`.

Add helpers in worker:

```ts
function readIdleTimeout(request: unknown): number {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return 1_800_000;
  }
  const value = (request as Record<string, unknown>).idleTimeoutMs;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value)) {
    return value;
  }
  return 1_800_000;
}
```

On each line, best-effort:
```ts
const sessionId = extractSessionIdFromRawLine(line); // thin wrapper around existing extract helpers
const toolName = extractToolNameFromRawLine(line);
void updateRunningJobObservation(cwd, jobId, {
  lastEventAt: nowIso(),
  ...(sessionId ? { sessionId } : {}),
  ...(toolName ? { lastTool: toolName } : {})
});
```

Pass `idleTimeoutMs: readIdleTimeout(initial.request)` into streaming runner (`0` means disabled — do not coerce).

- [ ] **Step 4: Write failing worker-level test (mock runner) that idle termination yields idle_timeout job**

If full worker tests are heavy, a focused test that `classifyRunOutcome` + transition path already covered in Task 2 may suffice; prefer one integration-style unit with mocked `runMimoStreaming` returning `{ exitCode: 124, terminationReason: "idle_timeout", ... }` and assert final job `errorCode`.

- [ ] **Step 5: Implement worker wiring until tests PASS**

- [ ] **Step 6: Commit**

```bash
git add src/core/jobs.ts src/core/job-store.ts src/core/job-transition.ts src/core/job-worker.ts test/unit/
git commit -m "$(cat <<'EOF'
feat(jobs): persist live stall observation and wire idleTimeoutMs

EOF
)"
```

---

### Task 5: Status rendering (`idleMs`, `processAlive`, …)

**Files:**
- Modify: `src/core/jobs.ts` (`JobStatusResult` additive fields)
- Modify: `src/core/job-render.ts`
- Modify: MCP status tool path if it bypasses render (should use `renderJobStatus`)
- Test: `test/unit/core/job-render.test.ts` (create/extend)

**Interfaces:**
- `JobStatusResult` adds optional:
  - `lastEventAt?: string | null`
  - `idleMs?: number | null`
  - `lastTool?: string | null`
  - `processAlive?: boolean | "unknown"`
  - `idleTimeoutMs?: number | null`

- [ ] **Step 1: Failing render tests**

```ts
const job = {
  /* minimal JobRecord */
  status: "running",
  startedAt: "2026-07-21T07:00:00.000Z",
  lastEventAt: "2026-07-21T07:12:34.000Z",
  lastTool: "write",
  idleTimeoutMs: 1_800_000,
  sessionId: "ses_abc",
  pid: 123,
  processIdentity: "win32:x"
} as JobRecord;

const status = renderJobStatus(job, {
  nowMs: Date.parse("2026-07-21T07:42:34.000Z"),
  processAlive: false
});
expect(status.idleMs).toBe(1_800_000);
expect(status.lastTool).toBe("write");
expect(status.sessionId).toBe("ses_abc");
expect(status.processAlive).toBe(false);
expect(status.idleTimeoutMs).toBe(1_800_000);
```

- [ ] **Step 2: Implement `renderJobStatus` fields**

Compute:
```ts
idleMs = job.status === "running" && job.lastEventAt
  ? Math.max(0, nowMs - Date.parse(job.lastEventAt))
  : null
```

`processAlive`: accept optional probe result from caller (`mimo_status` tool / CLI) via `options.processAlive`; if omitted, omit field or set `"unknown"`. Prefer probing in the status command/tool using existing `verifyProcessIdentity` / `captureProcessIdentity` when pid present.

Wire `mimo_status` / CLI `status` to pass probe result into `renderJobStatus`.

- [ ] **Step 3: Tests PASS**

- [ ] **Step 4: Commit**

```bash
git add src/core/jobs.ts src/core/job-render.ts src/codex/tools.ts src/cli/commands.ts test/unit/core/job-render.test.ts
git commit -m "$(cat <<'EOF'
feat(status): expose idleMs and processAlive for stall diagnosis

EOF
)"
```

---

### Task 6: SKILL + operations docs

**Files:**
- Modify: `skills/mimocode/SKILL.md`
- Modify: `doc/operations-guide.md`
- Modify: `scripts/validate-plugin.mjs` only if new required phrases are gated

**Content to add:**
- Work tools accept optional `idleTimeoutMs` (default 30m, `0` disables).
- Idle stop-loss → `timeout` / `idle_timeout` → treat like other attention terminals: callback turn → `mimo_result`.
- Long workflows (`parallel`) may raise `idleTimeoutMs`.
- Codex callback requires notify / `CODEX_THREAD_ID`; without it, terminal state is on disk only.
- Diagnostics: occasional `mimo_status` for `idleMs`/`lastEventAt`; no polling loops.

- [ ] **Step 1: Update SKILL + operations guide**

- [ ] **Step 2: Run `npm run validate:plugin`**

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add skills/mimocode/SKILL.md doc/operations-guide.md
git commit -m "$(cat <<'EOF'
docs: describe idleTimeoutMs and stall callback behavior

EOF
)"
```

---

### Task 7: Full verification

- [ ] **Step 1: Run unit suite**

Run: `npm test`

Expected: PASS

- [ ] **Step 2: Run lint/build**

Run: `npm run lint` && `npm run build` && `npm run validate:plugin`

Expected: PASS

- [ ] **Step 3: Manual smoke (optional but recommended)**

Against a scratch cwd, launch a short job with `idleTimeoutMs: 15000` and a mocked/hung mimo if available; or temporarily point `CODEX_MIMO_COMMAND` at a script that prints one JSONL line then sleeps. Confirm job becomes `timeout`/`idle_timeout` and status showed rising `idleMs` before terminal.

- [ ] **Step 4: Final commit only if docs/fix fixes remain**

---

## Spec coverage self-review

| Spec requirement | Task |
|------------------|------|
| Observability fields on status | Task 5 (+ persistence Task 4) |
| Live `sessionId` backfill | Task 4 |
| Idle stop-loss kill on JSONL silence | Task 1 |
| `timeout` + `idle_timeout` | Task 2 |
| Distinct public summary | Task 2 |
| `idleTimeoutMs` request default 30m / `0` off | Task 3 |
| Absolute `timeoutMs` unchanged; first wins | Task 1 + 3 |
| Outbox/Codex callback via existing timeout attention | Task 2 + 4 (no notify protocol change) |
| SKILL/docs | Task 6 |
| Tests listed in spec | Tasks 1–5, 7 |

## Placeholder / consistency check

- Termination reason name is consistently `"idle_timeout"` (not `idle` / `stalled`).
- Absolute timeout remains `process_timeout` → errorCode `"timeout"`.
- No soft-warn / `blocked` path in this plan.
- No Codex tool-surface fix in this plan.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-21-idle-timeout-observability.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute tasks in this session with checkpoints  

Which approach?
