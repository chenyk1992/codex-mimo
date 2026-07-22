# Idle timeout and job observability (Codex callback path)

Date: 2026-07-21  
Status: approved for implementation planning  
Related incident: `compose-mrub9g2s-a7tjae` stayed `running`/`editing` with no JSONL for 40+ minutes while MiMo processes remained alive; Codex received no callback because the job never reached an attention terminal state.

## Problem

Codex Desktop uses a callback-driven contract: after launching a work tool, the caller must not poll; completion or attention arrives via notification outbox → Codex turn → `mimo_result`.

Today the bridge only enforces an absolute run budget (`timeoutMs`). If MiMo stops emitting `--format json` lines (for example after a completed `write`, while waiting on an upstream model call) but keeps its process tree alive, the job remains `running` indefinitely until `timeoutMs` (often hours). No attention signal is produced, so Codex is never woken.

Operators also lack live stall signals: `sessionId` is often null until finalize, and `mimo_status` does not expose last-event age or last tool.

## Goals

1. **Observability** — `mimo_status` (and compact job views) expose enough live fields to diagnose silence without event polling loops.
2. **Automatic stop-loss** — after a configurable period with no MiMo JSONL, the job ends as `timeout` with `errorCode: idle_timeout`, the MiMo process tree is terminated, and the existing outbox path can notify Codex.
3. **Preserve host contracts** — normal progress still does not require polling; idle stop-loss and successful completion both rely on attention signals + notify when configured.

## Non-goals

- Inferring “thinking” from CPU, TCP, or OS wait state.
- Soft-warning callbacks or non-terminal attention signals (Codex does not poll).
- Defaulting idle stop-loss to `blocked` / `failed`, or requiring `mimo_resume` after stalls.
- Fixing Codex session tool-surface filtering (host may expose only a subset of MCP tools).
- Changing upstream MiMo event protocol; excluding “in-flight bash” from idle based on tool-start events is deferred.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Stop-loss status | `timeout` | Matches “no progress within budget”; already an attention kind that enqueues notify. |
| Stop-loss error code | `idle_timeout` | Distinct from absolute `timeout`, `prompt_setup_failed`, and `semantic_failure`. |
| Idle clock | Time since last stdout JSONL line | Matches the incident (silent after last `tool_use`). |
| Absolute clock | Existing `timeoutMs` unchanged | Overall wall budget remains separate; whichever fires first wins. |
| Default idle budget | `1_800_000` ms (30 minutes) | Loose enough for many long tools; overridable; `0` disables idle stop-loss. |
| Soft warn before kill | Not in v1 | Without a callback, soft warns do not help Codex; status fields cover diagnostics. |

## Status / request model

### Request (all work tools)

- Optional `idleTimeoutMs`: positive integer, or `0` to disable idle stop-loss.
- Default when omitted: `1_800_000`.
- Absolute `timeoutMs` behavior unchanged.

### Live job / `mimo_status` fields (additive)

| Field | Meaning |
|-------|---------|
| `sessionId` | Backfill as soon as a MiMo event carries `sessionID` / `sessionId` (do not wait for finalize). |
| `lastEventAt` | ISO timestamp of the latest consumed JSONL line (set on run start so boot is not immediately idle). |
| `idleMs` | `now - lastEventAt` while running; `null` when not applicable. |
| `lastTool` | Latest normalized tool name when known. |
| `processAlive` | Best-effort probe of recorded pid + process identity (`true` / `false` / `unknown`). |
| `idleTimeoutMs` | Effective idle budget for this job. |

Receipt shape for queued work tools stays unchanged.

### Terminal stop-loss record

- `status: "timeout"`
- `errorCode: "idle_timeout"`
- Public summary/error must remain distinguishable (for example “MiMoCode job idle-timed out.”), registered in known operator summaries so scrubbing does not collapse it to generic “MiMoCode job failed.”

## Runtime behavior

### Mount point

Implement idle tracking beside `runMimoCliStreaming` (or a thin wrapper used only by the job worker):

1. On process start: set `lastEventAt = now`.
2. On each stdout JSONL line: refresh `lastEventAt`; persist `sessionId` / `lastTool` / `lastEventAt` onto the job record when parsed.
3. Poll on a short interval (about 5s): if `idleTimeoutMs > 0` and `now - lastEventAt >= idleTimeoutMs`, request termination of the process tree (same mechanism as absolute process timeout).
4. Worker maps idle termination to job transition `timeout` + `idle_timeout` (distinct from absolute run-budget timeout, which may keep errorCode `timeout`).
5. `transitionJob` emits attention signal `timeout`; when `notificationTarget` is set, enqueue outbox delivery → notify-worker → Codex callback turn.

### Interaction with absolute timeout

```text
timeoutMs     = absolute run budget (existing)
idleTimeoutMs = max silence without JSONL (new; default 30m; 0 = off)
Whichever condition hits first wins.
```

### Codex callback sequence

```text
work tool (+ notify / injected CODEX_THREAD_ID)
  → running …
  → JSONL silence ≥ idleTimeoutMs
  → kill MiMo tree
  → status=timeout, errorCode=idle_timeout
  → outbox attention delivery
  → Codex callback turn
  → caller uses mimo_result(jobId)
```

### Notify caveat

Idle stop-loss always finalizes the job on disk. Codex callback only occurs when a notification target exists. Launch paths for Codex should prefer injected `CODEX_THREAD_ID` or explicit `notify: { type: "codex", threadId }`. Without notify, operators must discover the terminal state via status/jobs.

### False-positive mitigation

- Default 30 minutes of silence.
- Per-job `idleTimeoutMs` override; `0` disables.
- Docs/SKILL recommend larger idle budgets for long `parallel` / install-heavy workflows.
- Deferred: ignore idle while a tool is known in-flight if/when MiMo emits reliable tool-start events.

## SKILL / docs updates

- Document `idleTimeoutMs` on work tools.
- Callback path: after idle stop-loss, treat like other attention terminals — `mimo_result`, then decide whether to re-run with a narrower task or larger idle budget.
- Diagnostics: at most occasional `mimo_status` to read `idleMs` / `lastEventAt`; still forbid polling loops.
- Note notify requirement for Codex auto-callback.

## Testing

1. Streaming runner: silence ≥ `idleTimeoutMs` terminates the child; idle path distinguishable from absolute timeout where practical.
2. Worker/transition: idle stop-loss → job `timeout` + `idle_timeout` + attention signal; outbox created when notify is configured.
3. Status rendering: `lastEventAt`, `idleMs`, `lastTool`, live `sessionId`.
4. `idleTimeoutMs: 0` never idle-kills; absolute `timeoutMs` still applies.
5. Public summary for `idle_timeout` remains operator-distinguishable.

## Success criteria

Replaying a stall after productive edits (no further JSONL, process still alive): within the configured idle budget the job becomes `timeout` / `idle_timeout`; with notify configured, Codex receives a callback turn; during the stall, `mimo_status` shows a large `idleMs` and a stale `lastEventAt`.

## Implementation sketch (non-binding)

Likely touch points: `src/mimo/streaming-runner.ts`, `src/core/job-worker.ts`, job request schemas / `job-definitions.ts`, `job-render.ts` / status tools, `public-summary.ts`, `skills/mimocode/SKILL.md`, unit tests under `test/unit/`. Exact task breakdown belongs in the implementation plan after this spec is accepted.
