# Background Wake Flow Validation Plan

> **For agentic workers:** This is a read-only validation plan — no code changes. Use it to verify the wake flow connects correctly.

**Goal:** Validate that `mimo_compose` background jobs, `mimo_wake` heartbeat drafts, `mimo_wait` signals, and `mimo_result` final reports connect correctly.

**Architecture:** Four MCP tools form a polling loop: `mimo_compose` spawns a detached worker → worker writes signals/events → `mimo_wake` drafts a heartbeat prompt for Codex → `mimo_wait` polls for new signals → `mimo_result` returns the final report when the job settles.

**Tech Stack:** TypeScript, Zod schemas, JSONL signal files, `automation_update` heartbeat API

---

## Signal Flow Map

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. mimo_compose (background=true)                               │
│    src/codex/tools.ts:262-284                                   │
│    ├─ Creates job via job-store.ts:67-101                       │
│    ├─ Spawns detached worker via job-process.ts                 │
│    ├─ Returns renderJobLaunch (job-render.ts:18-32)             │
│    │   └─ Includes wake hint: { tool: "mimo_wake", jobId }      │
│    └─ If wait=true: polls via waitForJobToSettle (:561-568)     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Compose Job Worker (detached process)                        │
│    src/compose/job-worker.ts:59-328                             │
│    ├─ startRuntimeJob (:100) → writes "starting" signal         │
│    ├─ runMimoCliStreaming (:107-112)                             │
│    │   └─ onLine callback: appendRuntimeEvent (job-runtime.ts:33)│
│    │       ├─ Writes to .codex-mimo/events/<id>.events.jsonl    │
│    │       ├─ Infers phase from event (job-phase.ts:8-24)       │
│    │       ├─ Writes summary to .codex-mimo/jobs/<id>.log       │
│    │       └─ Appends signal on phase change (:54-73)            │
│    ├─ Waits for callback via hook.waitForCallback (:117)        │
│    ├─ Captures diff, status, verification                       │
│    ├─ Builds report via buildComposeReportFromRun               │
│    ├─ Writes report via writeComposeReport                      │
│    └─ completeRuntimeJob or failRuntimeJob                      │
│        └─ Writes "completed" or "failed" signal (:77-153)       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. mimo_wake (heartbeat draft for Codex)                        │
│    src/codex/tools.ts:386-394                                   │
│    ├─ Resolves job via resolveJobForSignals (:396-403)          │
│    └─ Calls buildCodexWakeHint (wake.ts:59-133)                 │
│        ├─ If job TERMINAL: returns result={ mimo_result, ... }  │
│        │   └─ Prompt: "Call mimo_result with {cwd, jobId}"      │
│        └─ If job ACTIVE: returns                                │
│            ├─ watch={ mimo_wait, arguments }                    │
│            ├─ heartbeat={ automation_update, mode:create,       │
│            │   kind:heartbeat, rrule:"FREQ=MINUTELY;COUNT=1" }  │
│            └─ Prompt: "Monitor job → call mimo_wait → if        │
│                attentionKinds hit, call mimo_result"             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. mimo_wait (poll signals without Codex-side polling)          │
│    src/codex/tools.ts:357-384                                   │
│    ├─ Resolves job via resolveJobForSignals                     │
│    ├─ Loops: readJobSignals (job-signals.ts:71-90)              │
│    │   └─ Reads .codex-mimo/jobs/<id>.signals.jsonl             │
│    │       Filters by sinceCursor, minLevel, limit              │
│    │   Sleeps pollMs (default 1000ms)                           │
│    │   Re-reads job status from disk                            │
│    └─ Returns { signals, timedOut, waitedMs }                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. mimo_result (final report)                                   │
│    src/codex/tools.ts:425-444                                   │
│    ├─ Filters jobs to non-queued/non-running                    │
│    ├─ Saves session to SessionStore if sessionId exists         │
│    └─ Returns renderJobResult (job-render.ts:57-73)             │
│        └─ Includes reportPaths, resumeHint, directResumeHint    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Source Areas Involved

### MCP Tool Handlers
| Tool | File | Lines | Role |
|------|------|-------|------|
| `mimo_compose` | `src/codex/tools.ts` | 256-335 | Background spawn + foreground fallback |
| `mimo_status` | `src/codex/tools.ts` | 337-345 | Read job state, return status |
| `mimo_events` | `src/codex/tools.ts` | 347-355 | Read signals with cursor/level filter |
| `mimo_wait` | `src/codex/tools.ts` | 357-384 | Poll signals until timeout or signal arrives |
| `mimo_wake` | `src/codex/tools.ts` | 386-394 | Build Codex heartbeat prompt |
| `mimo_result` | `src/codex/tools.ts` | 425-444 | Return final report for finished job |
| `mimo_cancel` | `src/codex/tools.ts` | 454-464 | Kill process, mark cancelled |
| `mimo_resume_job` | `src/codex/tools.ts` | 466-507 | Create child job from parent session |

### Job Runtime
| File | Lines | Role |
|------|-------|------|
| `src/core/job-runtime.ts` | 1-182 | Start, append events, complete, fail, cancel |
| `src/core/job-phase.ts` | 1-39 | Infer phase from normalized MiMo events |
| `src/core/job-signals.ts` | 1-117 | JSONL signal append/read with cursor+level filter |
| `src/core/job-store.ts` | 1-318 | Create/read/update/prune job records on disk |
| `src/core/job-render.ts` | 1-99 | Render launch, status, result responses |
| `src/core/jobs.ts` | 1-151 | Types: JobRecord, JobStatus, JobPhase, signals |

### Worker & Compose
| File | Lines | Role |
|------|-------|------|
| `src/compose/job-worker.ts` | 59-328 | Detached worker: run MiMo, capture diff, verify, report |
| `src/compose/streaming-runner.ts` | — | CLI runner with normalized event streaming |
| `src/compose/events.ts` | — | JSONL event parser → NormalizedMimoEvent |
| `src/compose/runner.ts` | — | Compose workflow execution + report building |
| `src/compose/report.ts` | — | Write markdown + JSON reports |

### Heartbeat
| File | Lines | Role |
|------|-------|------|
| `src/codex/wake.ts` | 1-133 | Build CodexWakeHint with watch/heartbeat/result |

---

## Validation Checklist

### 1. mimo_compose → Worker Spawn
- [ ] `ComposeInput.background: true` creates job via `createJobStore`
- [ ] `spawnJobWorker` is called with correct `(cwd, "compose", jobId, { onExit })`
- [ ] `onExit` callback calls `failJobOnUnexpectedWorkerExit` → `failRuntimeJob`
- [ ] Returns `renderJobLaunch` with `wake.hint = { tool: "mimo_wake" }`

### 2. Worker → Signal Production
- [ ] `startRuntimeJob` writes "starting" signal to `.signals.jsonl`
- [ ] `appendRuntimeEvent` normalizes each JSONL line → `NormalizedMimoEvent`
- [ ] Phase changes produce `phase_changed` signal (kind + level + summary)
- [ ] Milestone events produce `milestone` signal
- [ ] `completeRuntimeJob` writes `completed` signal with `reportPaths`
- [ ] `failRuntimeJob` writes `failed` signal with `errorCode`

### 3. mimo_wake → Heartbeat Draft
- [ ] Terminal job: returns `result = { tool: "mimo_result" }` with prompt to summarize
- [ ] Active job: returns `watch = { tool: "mimo_wait", arguments }` + `heartbeat = { automation_update, rrule: "FREQ=MINUTELY;COUNT=1" }`
- [ ] Prompt instructs Codex to call `mimo_wait`, check attentionKinds, then `mimo_result`

### 4. mimo_wait → Signal Polling
- [ ] Resolves job via `resolveJobForSignals` (latest job if no jobId)
- [ ] Loops: `readJobSignals` → check `signals.length` → sleep `pollMs`
- [ ] Breaks on: signals non-empty, job no longer active, or deadline
- [ ] Returns `{ signals, timedOut, waitedMs }` + `actions` hint

### 5. mimo_result → Final Report
- [ ] Filters to non-queued/non-running jobs only
- [ ] Saves to `SessionStore` if `sessionId` exists
- [ ] Returns `renderJobResult` with `resumeHint`, `directResumeHint`

### 6. Signal File Integrity
- [ ] `.signals.jsonl` uses monotonically increasing `cursor` values
- [ ] `readJobSignals` respects `sinceCursor`, `minLevel`, `limit` filters
- [ ] Signal `kind` matches: phase_changed, milestone, completed, failed, cancelled, timeout

---

## Risks Identified

### R1: Race Condition in mimo_wait Poll Loop
**Location:** `src/codex/tools.ts:369-377`
**Risk:** The loop reads job status from disk (`readJob`) to check `isActiveJobStatus`, but the worker writes status via `updateJob` which also writes to disk. If `mimo_wait` reads stale disk state, it may continue polling after the job completes, or exit early if a transient "completed" write is observed.
**Mitigation:** The `readJobSignals` check is the primary loop-break condition — even if job status is stale, signals will arrive. Low practical risk.

### R2: Signal File Growth
**Location:** `src/core/job-signals.ts:58-69`
**Risk:** Signals are appended without rotation. Long-running jobs (hours) could accumulate large signal files. `pruneState` cleans up entire job directories, but only for terminal jobs exceeding the max count.
**Mitigation:** Acceptable for current use — jobs typically produce <1000 signals. Monitor if background jobs become long-lived.

### R3: Heartbeat Self-Continuation
**Location:** `src/codex/wake.ts:100-132`
**Risk:** The heartbeat prompt says "create another heartbeat if the job is still active" after mimo_wait timeout. If Codex always creates a new heartbeat on timeout, the loop is self-sustaining until the job completes. This is by design, but means a stuck job creates indefinite heartbeats.
**Mitigation:** `timeoutMs` on `mimo_wait` (default 30min) bounds each iteration. The `DEFAULT_WAKE_TIMEOUT_MS` (30min) in wake.ts is also a limit.

### R4: Worker Exit Detection
**Location:** `src/codex/tools.ts:528-535`
**Risk:** `failJobOnUnexpectedWorkerExit` is registered as an `onExit` callback. If the worker crashes before `startRuntimeJob` writes the PID, the exit handler may not fire (or may fire for a stale job).
**Mitigation:** `isActiveJobStatus` check in the handler prevents false negatives — if the job is already terminal, the exit is ignored.

### R5: No Event Replaying
**Location:** `src/core/job-runtime.ts:33-75`
**Risk:** If the MCP server restarts while a worker is running, the worker continues writing signals but the MCP server has no in-memory state. However, `appendRuntimeEvent` is disk-only (JSONL + signals), so all state is recoverable from disk.
**Mitigation:** Low risk — the MCP server is stateless by design; all state is in `.codex-mimo/jobs/`.

---

## Verification Steps

To validate the flow end-to-end without editing files:

1. **Inspect job creation:** Check `.codex-mimo/jobs/state.json` after a background compose call — should have the job ID with status "queued"
2. **Inspect signals:** After worker starts, check `.codex-mimo/jobs/<id>.signals.jsonl` — should have at least "starting" signal
3. **Test mimo_wake:** Call `mimo_wake` with the job ID — should return `CodexWakeHint` with `watch` and `heartbeat` for active jobs
4. **Test mimo_wait:** Call `mimo_wait` with `sinceCursor=0` — should block until signals appear
5. **Test mimo_result:** After job completes, call `mimo_result` — should return `JobResult` with `reportPaths` and `resumeHint`
