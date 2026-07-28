# Operations Guide

## Enable and Validate

Build before starting the plugin because `.mcp.json` points to `dist/codex/mcp-server.js`:

```powershell
npm install
npm run build
npm run validate:plugin
codex-mimo doctor --cwd E:\project
```

The validator starts the built MCP server, calls `tools/list`, requires the canonical 13 tools, rejects removed work fields, and checks the packaged skill for repeated-wait guidance.

## Runtime Model

Every `plan`, `implement`, `review`, `fix-ci`, `resume`, and `compose` request follows the same path:

1. Validate the request and resolve one notification target.
2. Persist an authoritative `queued` job and immutable target.
3. Start one workspace-scoped internal supervisor and return a receipt; the supervisor starts `job-worker` and `notify-worker` processes as needed.
4. Transition to `running`, capture process identity, and execute `mimo run --format json` without a model override; MiMoCode resolves its own model and provider configuration. The run-scoped config disables only the `codex-mimocode` MCP entry to prevent the delegated process from recursively calling the bridge, while preserving every other MiMoCode MCP entry.
5. Persist JSONL events and wait for the internal `session.post` callback.
6. Capture Git evidence, run ordered development acceptance when required (or legacy verification), write reports, and classify the outcome.
7. Atomically persist the new status, attention signal, and outbox delivery.
8. Start `codex-mimo notify-worker`; the job worker does not wait for delivery.

The nine statuses are `queued`, `running`, `needs_input`, `blocked`, `stalled`, `completed`, `failed`, `cancelled`, and `timeout`. Only `queued` and `running` are active. `needs_input`, `blocked`, and `stalled` are paused results with no PID and may retain `sessionId` and checkpoint context.

### Development acceptance

`dev`, `execute-plan`, and `implement` cannot complete without ordered host acceptance. Prefer `acceptance.build` / `acceptance.test` / `acceptance.diffCheck`. Stages run fail-fast: build → test → diffCheck. Legacy `verification[]` maps to the test stage only. Missing build/test disposition at finalize pauses as `needs_input` with `acceptance_config_missing`. Stage failures finish `failed` with `build_failed`, `tests_failed`, `diff_check_failed`, or `delivery_contract_missing`. Compact `mimo_result` includes `failedStage`, failed command/tests, and a shortest-fix `suggestion`; resume those codes via Phase 2 `mimo_resume` and `.codex-mimo/reports/<jobId>.checkpoint.json`.

### Slice chains (`batchMode`)

Write roots may set `batchMode` to `auto` (default), `single`, or `sliced`. The orchestrator plans a slice manifest (`.codex-mimo/reports/<rootJobId>.slices.json`), persists `.codex-mimo/jobs/<chainId>.chain.json`, and runs slices sequentially — one at a time. Slice children are created without `notificationTarget`; only the root enqueues notification deliveries (including stall/failure attention and final completion). Invalid planning finalizes the root as `failed` with `slice_plan_invalid` (not resumable — re-launch after fixing the plan); a terminal failed slice finalizes the root as `failed` with `slice_failed` (resumable via `mimo_resume`). Crash recovery and `mimo_resume` on the root continue the current attention slice and skip completed slices. Standard `mimo_result` reports `completedSlices` / `remainingSlices` for chain roots.

`batchMode=single` requires bounded `allowedPaths`; bare repository-wide `**` is rejected at launch. Supported patterns are repository-relative: exact file (`src/app.ts`), directory prefix (`src/components`), or trailing `/**` only (`src/components/**`).

### Idle stop-loss

Every work request may include optional `idleTimeoutMs` (default 30 minutes; `0` disables idle stop-loss). Absolute `timeoutMs` is unchanged; whichever budget fires first wins. The idle clock measures silence since the last stdout JSONL line; `lastEventAt` is set on run start so boot is not immediately idle.

When silence exceeds the budget, the worker kills the MiMo process tree and finalizes as `timeout` with `errorCode: idle_timeout` (distinct from absolute run-budget timeout, which keeps `errorCode: timeout`). This emits an attention signal and enqueues outbox delivery like other terminal attention events.

Long workflows such as `parallel` may need a raised `idleTimeoutMs` when subagents can run for extended periods without JSONL.

### Effective-progress stop-loss

Separate from transport idle timeout, every work request may include `progressWarningMs` (default 2 minutes; `120_000`) and `progressTimeoutMs` (default 5 minutes; `300_000`). The effective-progress clock measures time since the last fingerprintable useful progress event — not merely JSONL silence. Repeated reasoning or duplicate tool fingerprints do not refresh the lease.

When `progressTimeoutMs` elapses without new useful progress, the worker atomically writes `.codex-mimo/reports/<jobId>.checkpoint.json`, terminates the owned MiMo tree, confirms process death when possible, and finalizes as immutable `stalled` with a resumable checkpoint. If termination cannot be confirmed, the job becomes `blocked` with `errorCode: stalled_process_alive` instead.

Setting `progressTimeoutMs: 0` disables effective-progress stop-loss and weakens the five-minute deliverability objective. Transport `idleTimeoutMs` and absolute `timeoutMs` remain available.

Distinguish wakeup paths:

- MiMo `session.post` — execution evidence inside the job worker; missing/error/cancelled callbacks can fail the job even with exit code 0. Only callbacks from the JSONL primary session (first `sessionID` in stdout) are accepted; child-session callbacks are ignored.
- Codex Desktop heartbeat — native in-chat scheduled follow-up that calls `mimo_status` / `mimo_result` in the same Desktop chat; this is the recommended Desktop visibility path. Omit `notify` and delete/cancel/stop the heartbeat schedule after `needs_input`, `blocked`, `stalled`, `completed`, `failed`, `cancelled`, or `timeout`.
- Codex App Server notification — optional compatibility history writeback through a frozen Codex target on an independent App Server connection. Outbox `delivered` does not mean the Desktop UI refreshed.
- Cursor companion — host stop-hook wakeup without Codex `notify`.

A work receipt alone does not prove a notification target exists unless the explicit Codex notification launch succeeded. Without a frozen Codex target, the terminal state is on disk only unless Desktop heartbeat or an explicit user request reads it.

While a job is `running`, `mimo_status` exposes live stall fields: `lastEventAt`, computed `idleMs`, `lastTool`, `processAlive`, effective `idleTimeoutMs`, `lastProgressAt`, `quietSince`, `progressWarningMs`, and `progressTimeoutMs`. On Desktop, heartbeat beats may call at most one `mimo_status` while non-terminal; do not poll or loop on control tools inside a single turn.

## Codex Task Target

Codex notification targets require an explicit `notify.threadId`. The launcher never infers task identity from a long-lived MCP server's environment. The packaged MCP config forwards only `CODEX_MIMO_CODEX_BIN` through `env_vars`; it does not forward `CODEX_THREAD_ID`.

### Codex Desktop launch sequence (recommended)

1. Launch one work job and **omit `notify`**.
2. Return the queued receipt and `jobId`.
3. Create an in-chat scheduled follow-up / heartbeat every 5 minutes for all Desktop MiMoCode jobs.
4. Each beat: at most one `mimo_status` at the default compact level. While `queued`/`running`, stop quietly. On `needs_input`, `blocked`, `stalled`, `completed`, `failed`, `cancelled`, or `timeout`: call at most one `mimo_result` at the default compact level, **delete/cancel/stop the heartbeat schedule**, then answer from status, changed files, tests, failure, bounded plan/review summary when present, and `reportPath`.
5. Never treat App Server `delivered` or later session-history reads as Desktop UI visibility.

### Codex App Server notify (compat / CLI)

1. Windows Desktop local discovery automatically checks `%LOCALAPPDATA%\\OpenAI\\Codex\\bin` version folders (`desktop-local`) after PATH candidates. It tries newer version folders before the stable root CLI because the root CLI can be older. A protected WindowsApps Desktop `codex.exe` is not a valid standalone callback CLI.
2. `CODEX_MIMO_CODEX_BIN` remains the authoritative optional override: set it to force one runnable standalone CLI before Codex Desktop starts, then restart Codex Desktop so the plugin MCP and detached workers inherit it.
3. Read the current task-scoped `CODEX_THREAD_ID` from the task command environment and pass it explicitly as `notify.threadId`; never store it globally.
4. Run `mimo_healthcheck` or `codex-mimo doctor` and require `mimo_healthcheck.codexNotification.ok === true` before expecting App Server callbacks. This is basic CLI readiness only: its safe source can be `configured`, `path`, or `desktop-local` and it does not validate a task.
5. Launch one work job with `notify: { type: "codex", threadId: "..." }`. The target-aware launch preflight validates the selected CLI, App Server protocol, and this explicit target task before job creation. Stop model-driven polling and let the compatibility callback turn answer from the prefetched public result without tools.

Explicit compatibility launches may send `notify: { type: "codex", threadId: "..." }`. The target is resolved once when the job is created. If launch fails with `Codex notification requires threadId` or a schema `threadId` required error, stop and keep `notify` on any later Codex callback attempt. Do not add `CODEX_THREAD_ID` to Windows system or user environment variables. CLI may omit notify or pass `--notify codex --thread-id <id>`; Codex Desktop recommended launches omit Codex notify and use the in-chat heartbeat; Cursor companion launches omit Codex notify and use the stop hook instead.

If preflight failed with `codex_cli_not_found`, `codex_cli_not_executable`, or `codex_app_server_unavailable`, run `mimo_healthcheck` and configure `CODEX_MIMO_CODEX_BIN`. Preflight failure does not automatically relaunch without notify; only an explicit user choice may switch to a no-notify Desktop heartbeat or Cursor companion launch.

Target-aware preflight validates CLI launchability and the explicit task before job persistence. Resolved Execa spawn failures (including protected WindowsApps Desktop binaries) classify to safe preflight codes. A successful preflight does not merge later App Server callback delivery into job execution; the durable outbox handles delivery independently after the job is created.

Diagnostic example when MiMo is healthy but Codex notification is not:

```text
MiMo ok + codexNotification.source=path + codex_cli_not_executable
→ PATH resolved a non-runnable Codex command (commonly protected WindowsApps)
→ set CODEX_MIMO_CODEX_BIN to a standalone CLI
→ restart Codex Desktop
→ require mimo_healthcheck.codexNotification.ok=true
→ retry with the same explicit notify.threadId
```

Codex App Server delivery is at-least-once across process crashes and remains a compatibility history-write path. A full notified job normally performs two system-only `thread/resume` probes: launch preflight and delivery preparation. In normal operation, each delivery attempt performs exactly one `turn/start`; the notify worker waits on `turn/completed` without calling `mimo_status`, `mimo_events`, or `mimo_wait`, and marks the outbox `delivered` only after the matching callback turn completes on that independent App Server connection. `delivered` does not mean the Desktop UI refreshed. The callback turn receives a prefetched public result and must not call tools. If the process crashes after `turn/start` but before callback completion is settled, the same persisted event ID can be retried and start a duplicate callback turn. The callback prompt includes that event ID and identifies the notification as a possible retry. Busy or temporarily unavailable tasks retry; missing, forbidden, or non-executable CLI launch failures are permanent after one attempt.

### Codex notification error codes

| Error code | Meaning | Action |
| --- | --- | --- |
| `codex_cli_not_found` | No standalone CLI resolved (preflight or delivery) | Set `CODEX_MIMO_CODEX_BIN` to a valid executable. |
| `codex_cli_not_executable` | Resolved path is blocked, including the WindowsApps Desktop binary | Use a standalone CLI outside the protected Desktop package. |
| `codex_app_server_incompatible` | CLI protocol does not match the client | Upgrade the standalone CLI and rerun doctor. |
| `codex_app_server_unavailable` | Temporary process/transport failure | Retry after doctor succeeds. |
| `codex_thread_busy` | Original task is still active | Let durable backoff retry. |
| `codex_thread_missing` / `codex_thread_forbidden` | Target cannot be resumed | Verify the explicit task ID and permissions. |
| `codex_turn_interrupted` | Callback turn ended interrupted | At most one retry (two total attempts). |
| `codex_turn_failed` | Callback turn failed | At most one retry (two total attempts). |
| `codex_turn_timeout` | Five-minute callback budget expired | Fail the current event immediately after the first attempt. |

### Codex callback turn diagnostics

| Observation | Meaning | Action |
| --- | --- | --- |
| `delivering` after `turn/start` | Callback model turn is still running; Node lease heartbeat owns the wait. | Do not poll from Codex. |
| `pending` + `codex_turn_interrupted` | Callback turn ended interrupted. | Allow at most one retry. |
| `pending` + `codex_turn_failed` | Callback turn failed. | Allow at most one retry. |
| `pending` + `codex_turn_timeout` | Five-minute callback budget expired. | Event already failed; do not expect a second turn for this timeout. |
| `delivered` | Matching callback turn completed on the independent App Server connection using prefetched result. Does not mean Desktop UI refreshed. | Prefer Desktop heartbeat for UI visibility; history may be readable later. |

A full notified job normally performs two system-only `thread/resume` probes: launch preflight and delivery preparation. Each delivery attempt performs exactly one `turn/start`; the notify worker waits on `turn/completed` without model polling and marks the outbox `delivered` only after the matching callback turn completes on that independent App Server connection, not merely when App Server accepts `turn/start`. `delivered` does not mean the Desktop UI refreshed.

## Webhook Contract

Configure a webhook with an HTTP(S) URL and the name of a secret environment variable:

```json
{
  "notify": {
    "type": "webhook",
    "url": "https://receiver.example/jobs",
    "secretEnv": "MIMO_NOTIFY_SECRET"
  }
}
```

The request body is compact versioned JSON. Headers are:

- `X-Codex-Mimo-Event-Id`: stable `jobId:signalCursor:targetKind` idempotency key
- `X-Codex-Mimo-Signature`: lowercase hex HMAC-SHA256 of the exact request bytes

The receiver must deduplicate using the event ID. Only the variable name is persisted; the secret value is read immediately before delivery and never written below `.codex-mimo`. Missing/empty secrets and ordinary 4xx responses are permanent failures. Connection errors, 408, 429, and 5xx retry.

## Retry Isolation

Retries occur immediately after creation, then after 10 seconds, 1 minute, and 5 minutes; later attempts remain 5 minutes apart. Delivery stops after 30 minutes. A delivery lease prevents two workers from owning the same attempt, renews during slow calls, and is reclaimed after expiry.

Notification state is auxiliary. Delivery failure records `failed`, attempts, and a sanitized last error in the outbox, but does not mutate job status. Use `mimo_status` or `mimo_result` to inspect both states.

## Controls

`mimo_result` defaults to a compact delivery record: status, changed files, compact verification/acceptance stage results, failure, report path, and a bounded plan/review summary when applicable. Complete final text is not returned by default. `reportPath` is repository-relative when the artifact is inside the requested workspace. Default compact `mimo_result` JSON must not exceed 6,000 UTF-8 bytes. Acceptance failures include compact fields such as `failedStage`, failed command/tests, and a shortest-fix `suggestion`. When multiple failures occur, compact `failure.causes` keeps at most three entries; `standard` and `full` retain the complete list in `failureCauses`.

Use `level: "standard"` for bounded operator diagnostics and `level: "full"` only for explicit manual troubleshooting. `full` reads complete semantic and verification artifacts; normal Desktop heartbeat and automatic callback delivery remain compact.

Full responses inline at most 1,000,000 bytes per artifact. A larger artifact is not truncated: the result contains `artifact_too_large`, the exact artifact path, and its byte count.

Every finalized job has structural report paths. Complete semantic output is saved separately as `<jobId>.result.md`; plans additionally use `<jobId>.plan.md`; full verification stdout/stderr uses `<jobId>.verification.json`; continuation state uses `<jobId>.checkpoint.json`; slice chains use `<rootJobId>.slices.json` and `.codex-mimo/jobs/<chainId>.chain.json`. Structural `.json`/`.md` reports link to these files and do not inline their content. Recognized credentials are redacted before semantic or verification artifacts are persisted and before full diagnostics are returned.

CLI `status` defaults to `standard` for humans; MCP `mimo_status` defaults to compact.

```powershell
codex-mimo status --cwd E:\project --job-id <job-id>
codex-mimo result --cwd E:\project --job-id <job-id>
codex-mimo result --cwd E:\project --job-id <job-id> --level full
```

- `mimo_status`: current job, phase, recent progress, and notification summary. Default compact for MCP heartbeat; CLI defaults to `standard`.
- `mimo_events`: cursor-based progress for explicit diagnosis
- `mimo_wait`: one attention-event wait for an explicit diagnostic request
- `mimo_result`: compact delivery result by default; `standard` adds key diagnostics; `full` is explicit manual troubleshooting. A planning run with no readable final result finishes `failed` with `errorCode: "result_missing"`.
- `mimo_cancel`: cancel queued/running work and terminate only its confirmed owned process
- `mimo_jobs`: list recent authoritative records

Normal Codex Desktop operation uses the in-chat heartbeat: at most one `mimo_status` per beat while non-terminal, then at most one `mimo_result` before deleting the schedule. Compatibility App Server notify launches use none of these for automatic delivery; the callback turn answers from the prefetched public result and must not call tools. Direct user diagnostics may still use `mimo_result`, `mimo_status`, `mimo_events`, or one `mimo_wait`. Ordinary phase and milestone signals do not create a caller notification.

### Cursor companion zero-poll

With the Cursor companion hooks installed (`hosts/cursor/README.md`), agents must not poll MCP control tools while a job is `queued` or `running`. The companion registers each work-tool receipt on `afterMCP` and blocks inside the `stop` hook until the job needs attention or the host wait budget is exhausted.

A long `stop` hook duration while MiMoCode runs is expected — the companion waits for the job, not the agent. When the wait budget is exhausted, the watch remains on disk and the hook emits a short follow-up; the next `stop` can resume waiting. Set `CODEX_MIMO_COMPANION_WAIT_SEC` (for example `60`) to cap the host wait for a quick exhausted diagnostic instead of waiting the full job duration.

Without the companion, callers demote to stop-after-launch: report the receipt and `jobId`, then use control tools only when the user explicitly asks — at most one `mimo_wait` followed by at most one `mimo_status`, never a polling loop.

CLI exit codes are: `0` success; `2` command, input, or schema error; and `1` runtime failure, including an unhealthy `doctor` or `healthcheck`.

The gated real-Codex smoke (`RUN_LOCAL_CODEX_NOTIFY_SMOKE=1`) proves App Server session-history writeback on an independent connection, not Desktop UI refresh. It must run from an idle, dedicated Codex task with a runnable standalone CLI and the task's `CODEX_THREAD_ID` passed explicitly as `notify.threadId`. Set `CODEX_MIMO_INSTALLED_PLUGIN_ROOT` to the absolute installed codex-mimocode package root before enabling it. The smoke rejects the source checkout, a missing installed package, or an installed manifest version that differs from the checkout, and starts the stdio MCP server from that installed root. It first resolves MiMoCode to an absolute `CODEX_MIMO_COMMAND`, then removes every PATH directory exposing a Codex command and clears `CODEX_MIMO_CODEX_BIN`; this keeps MiMoCode launchable when both commands share a directory while making Desktop-local Codex fallback deterministic. Its completion notification starts a real callback turn in that task, so using an active task can cause busy retries or mix smoke instructions with unrelated work. Do not run it from a task handling other work: the smoke deliberately resumes that task and reads the newest assistant response from the target session rollout after the prefetched-result callback completes. Passing that read proves three separate facts: the complete MiMo marker is present in `<jobId>.result.md`, the callback assistant response is non-empty but does not echo that marker, and exactly one callback `turn/start` reaches independent session history.

## Parent-Job Continuation

Call `mimo_resume` with a `needs_input`, `blocked`, `stalled`, eligible `timeout`, or resumable-failure parent `jobId`. Resumable failure codes include `build_failed`, `tests_failed`, `diff_check_failed`, `delivery_contract_missing`, and `slice_failed`. Safety isolation codes (`prompt_identity_mismatch`, `callback_session_mismatch`, `event_session_mismatch`, `write_scope_violation`, `acceptance_command_unavailable`) are not resumable — restart with a corrected objective, `allowedPaths`, or `acceptance`. `slice_plan_invalid` is not resumable — start a new job after correcting the objective or `batchMode`. For `needs_input` (including `acceptance_config_missing`) and `blocked`, supply additional `task` text. For `stalled`, checkpoint-backed `timeout`, and resumable acceptance failures, `task` is optional and defaults to the first remaining checklist item. The parent must have a saved `sessionId` and/or durable checkpoint at `.codex-mimo/reports/<jobId>.checkpoint.json`. Checkpoint-only resume prompts forbid broad repository scans and repeat only checkpoint context.

The launcher creates a new `resume` child job, copies the parent session when present, and inherits the parent target unless the request explicitly supplies another target. For slice-chain roots (or an attention slice child), resume continues the current unfinished slice with a null notification target and never relaunches completed slices. Parent and child records remain independently auditable. Never resume while `stalled_process_alive` is set.

## Recovery

Authoritative records live at `.codex-mimo/jobs/<jobId>.json`; `state.json` is only a cache and is rebuilt from records. Writes use temporary files plus rename. Pending transition metadata allows an interrupted signal/job/outbox sequence to finish without duplicating the attention event.

The workspace supervisor holds a physical-workspace process lock, adopts existing job/notification worker ownership after handoff, replaces crashed workers while queued/running jobs or unfinished deliveries remain, and stops when no work remains. Worker startup retries are bounded; a permanently unstartable queued job is failed through the normal transition/signal/notification path. If a job worker restarts while a record says `running`, it verifies the PID and OS process identity. A confirmed inactive or terminated process becomes `failed` (or `timeout` after an expired deadline) with recovery evidence. Uncertain termination leaves the job `running` with PID and identity intact so a later replacement worker can retry confirmation safely; it does not emit a false terminal result.

The notification worker scans unfinished outbox entries. It reclaims expired `delivering` leases, preserves attempt generation ownership, and deduplicates each delivery by event ID.

## Files

```text
.codex-mimo/
  jobs/<jobId>.json
  jobs/<jobId>.log
  jobs/<jobId>.events.jsonl
  jobs/<jobId>.signals.jsonl
  jobs/notifications.jsonl
  callbacks/<invocationId>.json
  reports/
  events/
  diffs/
  inputs/
  runtime-hooks/
```

The internal callback endpoint is temporary and authenticated. Callback files contain only invocation/event/time/session/outcome fields; final text, raw metadata, unknown fields, and callback error strings are never persisted there. Missing, error, or cancelled `session.post` evidence affects execution success; it is separate from caller delivery.

## Execution isolation and safety

### Prompt identity

The bridge hashes the final MiMo prompt and passes it to the internal hook. On the primary session's first user query, a mismatch cancels before any model step with `prompt_identity_mismatch`. This failure is not resumable — restart with the correct objective; do not call `mimo_resume`.

### Session binding

The first JSONL `sessionID` becomes the run session. The hook binds the first `session.pre` session as primary; child sessions are ignored for completion. The worker calls `bindRunSession` when JSONL arrives; only matching `session.post` callbacks resolve the job. Child-session callbacks are staged then dropped. JSONL/callback session mismatch yields `callback_session_mismatch`; JSONL session drift mid-run yields `event_session_mismatch`.

### Write scope (`allowedPaths`)

Write jobs may declare `allowedPaths`. Patterns must be repository-relative: exact file, directory prefix, or trailing `/**` only. Rejected: bare `**`, absolute paths, `..`, UNC paths, and unsupported globs. `batchMode=single` requires bounded `allowedPaths` at launch. Known `write`/`edit` tools are blocked at the hook when out of scope; a mandatory post-run audit can also finish `failed` with `write_scope_violation` (`failedStage: diff_check`).

### Build wrapper resolution

For detected `mvn` / `gradle` acceptance commands, the bridge resolves repository wrappers before preflight and execution: Windows prefers `mvnw.cmd` / `gradlew.bat`; POSIX prefers `./mvnw` / `./gradlew`. Explicit path entries are not rewritten. Write jobs preflight build/test commands before edits; missing or non-executable entries fail with `acceptance_command_unavailable`.

### Safety error codes

| Error code | Meaning | Recovery |
| --- | --- | --- |
| `prompt_identity_mismatch` | MiMo user query did not match the job prompt | Restart with the correct `task`; not resumable |
| `callback_session_mismatch` | `session.post` session differed from the JSONL run session | Inspect events and callback diagnostics; restart |
| `event_session_mismatch` | JSONL session identity changed during the run | Restart the job |
| `write_scope_violation` | Out-of-scope write or changed file | Tighten `allowedPaths`; relaunch with narrower scope |
| `acceptance_command_unavailable` | Build/test command missing or not executable before edits | Supply explicit `acceptance`, fix wrapper permissions, or install the tool |

### Multi-cause failures

When timeout, scope, callback, and acceptance failures coexist, structured results preserve all causes. Compact `mimo_result` truncates `failure.causes` to three entries (primary first). `standard` and `full` expose the complete `failureCauses` list.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Work remains `queued` | Inspect the job log and worker spawn permissions; stale queued records become failed |
| Restarted work remains `running` | Process exit or termination is not yet confirmed; keep the supervisor active and resolve OS permission/probe failures |
| Job completed but notification failed | Inspect `notification.lastError`; job result remains valid |
| Webhook gets duplicates | Deduplicate by `X-Codex-Mimo-Event-Id` |
| Webhook signature mismatch | Compute HMAC over the exact raw body and verify the named environment secret |
| Codex target is wrong | Verify the explicit `notify.threadId` matches the originating task; never rely on a global `CODEX_THREAD_ID` |
| Launch fails with `Codex notification requires threadId` | Do not retry by omitting `notify`; pass the current task ID explicitly as `notify.threadId` |
| Notification shows `codex_cli_not_executable` | Point `CODEX_MIMO_CODEX_BIN` at a standalone CLI outside protected WindowsApps packages; restart Codex Desktop and confirm `mimo_healthcheck.codexNotification.ok === true` |
| Launch preflight failed before job creation | Report the safe code; do not automatically relaunch without notify; run `mimo_healthcheck` and configure `CODEX_MIMO_CODEX_BIN` |
| Planning job failed with `result_missing` | The planning run had no readable final result; inspect events only as a diagnostic, then re-run with a clearer task |
| Need progress for diagnosis | Read `mimo_status` or `mimo_events`; use a single `mimo_wait` only when requested |
| Job asks for information | Call `mimo_result`, collect the answer, then create a child with `mimo_resume` |
| Job silent but `running` | Check `mimo_status` for `idleMs`, `lastEventAt`, `lastProgressAt`, `quietSince`, and `processAlive`; raise `idleTimeoutMs` for long `parallel` runs if needed |
| Job ended `stalled` | Read compact `mimo_result.attention` for `lastCommand`, reason, and `resume`; call `mimo_resume` to create a child from the checkpoint |
| Job failed with `build_failed` / `tests_failed` / `diff_check_failed` / `delivery_contract_missing` | Read compact `failedStage`, failed command/tests, and `suggestion`; call `mimo_resume` with the parent `jobId` (Phase 2 checkpoint resume) |
| Job failed with `prompt_identity_mismatch` | MiMo received the wrong query; restart with the correct objective — do not `mimo_resume` |
| Job failed with `callback_session_mismatch` or `event_session_mismatch` | Session binding broke; inspect `jobs/<jobId>.events.jsonl` and callback diagnostics; restart |
| Job failed with `write_scope_violation` | Out-of-scope write or audit failure; relaunch with tighter `allowedPaths` |
| Job failed with `acceptance_command_unavailable` | Command missing before edits; add explicit `acceptance` with repo wrapper path or install the tool |
| Job paused with `acceptance_config_missing` | Supply `acceptance.build` / `acceptance.test` (or detectable project commands) via `mimo_resume` `task` / relaunch with explicit `acceptance` |
| Job ended `timeout` / `idle_timeout` | On Desktop heartbeat: next beat calls `mimo_result` once and deletes the schedule; resume with `mimo_resume` when a checkpoint exists; for explicit App Server notify, wait for the compatibility callback (prefetched public result, no tools), or use `mimo_result` for explicit user diagnostics; re-run with a narrower task or larger idle budget if appropriate |
| Terminal job but no Desktop answer | Confirm a Desktop heartbeat was created and cleaned up; App Server `delivered` alone is not Desktop UI proof — without heartbeat or an explicit user request, state is on disk only (`mimo_result` / `mimo_jobs`) |

## Disable or Roll Back

Disable the MCP entry in the Codex plugin configuration or remove the installed plugin directory. Existing `.codex-mimo` records are ordinary workspace files and remain available for audit. Do not delete active job state until its owned processes have been checked.
