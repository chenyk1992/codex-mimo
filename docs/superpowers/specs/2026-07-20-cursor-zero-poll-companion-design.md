# Cursor zero-poll companion design

Date: 2026-07-20  
Status: approved for implementation planning  
Primary approach: host-level blocking wait in Cursor `stop` hook (Approach 3)

## Context

Codex-MiMo already saves tokens on the MiMo side (large edits, repo scans, verification reports). Remaining cost on the Cursor/Codex caller side is orchestration: assembling tasks, waiting, reading results, and troubleshooting hangs.

Observed expensive path (**C**): Cursor with direct MCP, where the agent polls `mimo_status` / `mimo_events` / `mimo_wait`.

Existing Cursor companion (**B**) is closer to push, but today on `stop` while a job is still `queued`/`running` it injects a follow-up that tells the agent to call `mimo_status` (or diagnostic `mimo_wait`). That recreates C-style polling inside agent turns. Hook `timeout` is also only 30s.

Codex callback path (**A**, `notify: codex`) stays as-is.

## Goals

1. **Zero agent polling** while a job is `queued` or `running`: no Cursor agent turns and no `mimo_status` / `mimo_events` / `mimo_wait` for normal progress.
2. **Wake only on attention**: `needs_input`, `blocked`, `completed`, `failed`, `cancelled`, `timeout`.
3. **Tiny payloads**: follow-ups and tool results must not dump events/JSONL/long logs; prefer path pointers.
4. **Do it once**: move blocking wait into the companion host process, not into agent tool loops.
5. **Keep C as a demotion**: without companion, still usable; skill forbids tool thrashing after timeouts.

### Success criteria

- Typical `mimo_plan` with companion: from queued to completed → **0** intermediate status/events/wait calls; after attention → **1** `mimo_result`.
- Follow-up text hard cap **≤ 400 characters**; must not embed signal arrays or raw JSONL.
- Without companion: launch still works; skill requires stop-after-launch and at most one wait + one status when the user insists on waiting.

## Non-goals (v1)

- Do not replace or redesign Codex `notify: codex`.
- Do not add a standing daemon or separate UI (revisit only if Cursor hooks prove insufficient).
- Do not add a full `mimo_diagnose` MCP tool in v1 (inline diagnosis strings only).
- Do not guarantee cross-session auto-resume after abort/window close (watches may remain on disk; wake needs a later `stop` or user prompt).

## Architecture overview

```text
Path B′ (Cursor + companion) — default recommendation
  afterMCP(work tool) → register watch
  agent stop → companion blocks inside hook, polls job JSON
  attention or wait budget exhausted → short followup_message
  agent → mimo_result once → summarize

Path A (Codex + notify) — unchanged
  work tool → notify-worker → thread/resume → mimo_result

Path C (no companion) — demotion
  work tool → tell user jobId → stop
  optional: one mimo_wait; on timeout one mimo_status; then stop
```

**Companion owns** registration, host-side wait, short follow-ups.  
**MCP owns** job execution, artifacts, control tools, Codex notify.  
Do **not** make long blocking wait the default behavior of MCP `mimo_wait` for Cursor (that still occupies an agent tool turn).

## Section 2 — Host blocking wait

### Cursor constraints

| Capability | Implication |
|------------|-------------|
| `stop` + `followup_message` | Only official auto-wake channel after a turn |
| `timeout` (seconds) | Blocking wait must finish before Cursor kills the hook |
| `loop_limit` | Cap auto follow-ups; not used for progress polling |
| `status === "aborted"` | No follow-up |

Zero-poll **requires** sleeping/polling inside the `stop` hook process. Emitting active follow-ups that ask for `mimo_status` is explicitly rejected.

### State machine

```text
afterMCP(work tool) → upsert watch(cwd, jobId)

stop:
  aborted? → {} 
  unacked attention? → immediate short follow-up (mimo_result) → ack
  active watch? → block-poll job file until:
      (a) attention → follow-up A
      (b) wait budget exhausted → follow-up B + remove from auto-wait queue
  else → {}
```

### Polling

- Read only `<cwd>/.codex-mimo/jobs/<jobId>.json` (`status`, optional `phase` / `updatedAt` / request timeout fields).
- **Do not** read events.jsonl, signals, or logs into the follow-up.
- Interval: **30s → 45s → 60s**, cap **60s** (MiMo analysis/execution is slow).
- Wait budget (min of):
  - Remaining job deadline: `startedAt + request.timeoutMs` (same rule as worker; default 1_800_000 ms)
  - Optional `CODEX_MIMO_COMPANION_WAIT_SEC * 1000`
  - Hook timeout budget minus **safety pad (~10s)** so stdout can still be written

### hooks.json

- `timeout`: **1860** (seconds) — covers default 30 min job + pad
- `loop_limit`: **5** — for attention → result → possible resume cycles; **not** for polling
- `failClosed`: **false**

### Follow-up templates (hard rules)

**A — attention (≤ ~300 chars, absolute max 400):**

```text
MiMo job <jobId> needs attention (status=<status>).
Call mimo_result with {"cwd":"...","jobId":"..."}.
Summarize for the user; do not invent outcomes. If needs_input/blocked, ask user then mimo_resume.
```

**B — budget exhausted:**

```text
MiMo job <jobId> still <status> after host wait.
Call mimo_status once OR mimo_cancel. Do not loop wait/events. Report to user.
```

Same `(jobId, status)` must not re-trigger after ack.

### Multi-job

One `stop` invocation services **one** priority watch (FIFO or first to reach attention). Others remain for a later `stop`.

### Risks

| Risk | Mitigation |
|------|------------|
| Long-running hook UX | Document as expected; env override for shorter waits |
| Hook killed before stdout | Safety pad; emit exhausted follow-up before pad |
| Session stuck in stop | Acceptable for the waiting chat; multi-job via queue |
| Path C without companion | Skill + compact MCP timeout payloads |

## Section 3 — MCP / skill demotion and path split

### Companion vs MCP

| Owner | Responsibility |
|-------|----------------|
| Companion | Watches, blocking wait, short `followup_message` |
| MCP | Jobs, MiMo run, reports, `mimo_result` / status / cancel / resume, Codex notify |
| Skill/docs | Behavioral contract per path |

### Path C MCP contract (v1, minimal)

1. **`mimo_wait` on timeout**: `timedOut: true`, `signals: []`, `diagnosis` (≤160 chars), `nextAction`: `status_once` | `cancel` | `stop`.
2. **`mimo_events`**: default `minLevel` → **`warn`** (pass `debug` explicitly for full detail).
3. **`mimo_status`**: remain compact (≤3 progress lines preferred).
4. **No `mimo_diagnose` tool in v1.**

### Skill contract

**With companion (recommended)**  
1. Call work tool → briefly report queued receipt → **stop** (no `mimo_wait`).  
2. On hook wake → only `mimo_result` → summarize.  
3. Never poll status/events/wait while running.

**Without companion (C)**  
1. Launch → report jobId → **stop**.  
2. If user insists on waiting: at most **one** `mimo_wait`; after timeout at most **one** `mimo_status`; then stop and report.  
3. Never loop wait/events/log after timeout.

**Codex**  
Keep existing callback-driven guidance; default notify via injected `CODEX_THREAD_ID`.

### Exhausted-watch policy (approved)

After wait budget exhaustion: **remove the job from the automatic wait queue** (mark exhausted / ack equivalent) so the next `stop` does not immediately block another ~30 minutes. User must explicitly continue (status/cancel/new turn) or a new work receipt must re-register the watch.

### Config

| Knob | Purpose |
|------|---------|
| `CODEX_MIMO_COMPANION_WAIT_SEC` | Override companion wait budget |
| Poll schedule | Fixed 30s → 45s → 60s |
| `~/.codex-mimo/companion-watch.json` | Durable watches; optional `lastPolledAt` / `waitStartedAt` for debug only (never in follow-up) |

## Section 4 — Modules, shapes, tests, phases

### Module changes

| Area | Files | Change |
|------|-------|--------|
| Companion core | `src/companion/watch.ts` | Remove active→status follow-up; add host wait; exhausted; short templates |
| Companion CLI | `src/companion/cli.ts` | Async blocking `stop` |
| Cursor host | `hosts/cursor/hooks.json`, `install.mjs`, `README.md` | timeout 1860, loop_limit 5, docs |
| MCP wait | `src/codex/tools.ts` (+ schemas if needed) | Timeout diagnosis fields |
| Events default | `src/codex/tool-schemas.ts` | `minLevel` default `warn` |
| Skill | `skills/mimocode/SKILL.md` | Three-path contract |
| Docs | `doc/operations-guide.md`, README as needed | Zero-poll path + C demotion |
| Tests | `test/unit/companion/*`, MCP tool tests | See below |
| Validator | `scripts/validate-plugin.mjs` | Update skill checks |

**Out of scope for v1:** job-worker, notify adapters, Codex app-server protocol, new MCP tool names.

### Data shapes

```ts
interface CompanionWatch {
  cwd: string;
  jobId: string;
  kind?: string;
  createdAt: string;
  conversationId?: string;
  waitStartedAt?: string;
  lastPolledAt?: string;
  exhaustedAt?: string;
}

type HostWaitOutcome =
  | { type: "attention"; status: string }
  | { type: "exhausted"; status: string; waitedMs: number }
  | { type: "no_active" };
```

State file may stay `version: 1` if fields are additive only.

`mimo_wait` timeout addition:

```ts
{
  timedOut: true,
  signals: [],
  diagnosis: string,
  nextAction: "status_once" | "cancel" | "stop"
}
```

### Behavioral rules (do not drift)

1. `stop` + aborted → `{}`, no block.
2. Unacked attention → immediate follow-up, no block.
3. Active only → block; do not write partial stdout early.
4. Attention → template A; exhausted → template B + dequeue; then exit hook.
5. After wake, agent should call only `mimo_result`.
6. `needs_input` / `blocked`: after user `mimo_resume`, new receipt re-registers via `afterMCP`.

### Tests

**Unit (required)**

- Active path must not mention `mimo_status` / `mimo_wait` in follow-up.
- Fake clock: poll schedule 30→45→60; flip job to `completed` mid-wait → attention follow-up.
- Budget exhaust → exhausted copy + no auto re-wait.
- Ack suppresses duplicate same-status follow-up.
- Abort → no follow-up.
- Follow-up length ≤ 400; no `"signals"` / large JSON blobs.
- `mimo_wait` timeout: empty signals + diagnosis + nextAction.
- `mimo_events` default minLevel is `warn`.

**Manual checklist**

- Install hooks → short `mimo_plan` → zero intermediate status tools → one `mimo_result`.
- `CODEX_MIMO_COMPANION_WAIT_SEC=60` → one diagnostic follow-up, no re-block loop.

### Implementation phases

| Phase | Work | Done when |
|-------|------|-----------|
| **P0** | Companion blocking wait + remove active status polling + exhausted + templates | Unit tests green; old status-nudge tests rewritten |
| **P1** | hooks/installer/README: timeout 1860, env, long-hook UX | Installed hooks.json matches contract |
| **P2** | MCP wait timeout fields; events default `warn` | Unit tests + stable exported types |
| **P3** | Skill + operations-guide three-path docs | validate-plugin updated |
| **P4** | Manual acceptance; edge fixes (multi-job FIFO, safety pad) | README trial says zero intermediate tools |

Order: **P0 → P1 → P2 → P3 → P4**. P1 and P2 may overlap after P0 starts; P0 is the value of Approach 3.

## Open decisions locked in review

- Prefer Approach 3 (host zero-poll) over incremental MCP-only tightening.
- Poll intervals: **30s → 45s → 60s** (cap 60s).
- Budget exhausted → **remove from automatic wait queue**.
- No `mimo_diagnose` tool in v1.
- Codex notify path unchanged.
