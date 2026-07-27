# Codex MiMoCode Bridge

Codex-MiMo lets Codex delegate planning, implementation, review, CI repair, continuation, and Compose workflows to MiMoCode. Every work entry creates a persisted background job and returns immediately with a compact receipt.

## Prerequisites

- Node.js 20 or newer
- MiMoCode installed and authenticated (`mimo --version`)
- Git for diff/status capture and read-only checks

## Setup

```powershell
npm install
npm run build
npm run validate:plugin
```

The plugin manifest is `.codex-plugin/plugin.json`; `.mcp.json` starts `dist/codex/mcp-server.js` over stdio. Run `codex-mimo doctor --cwd <project>` to diagnose the selected checkout or installed plugin.

## Unified Job Lifecycle

The six work tools and matching CLI commands share one launcher, definition registry, worker, status transition engine, and notification outbox:

```text
work request -> queued receipt -> job worker -> MiMoCode JSONL + session.post
             -> finalization/verification -> attention signal -> notification outbox
             -> webhook receiver or original Codex task
```

Job status is one of:

- `queued`: persisted, worker not yet running
- `running`: MiMoCode or finalization is active
- `needs_input`: paused until the caller supplies information
- `blocked`: paused because an external condition prevents progress
- `stalled`: no effective progress within the progress stop-loss; durable checkpoint written
- `completed`: execution and required verification succeeded
- `failed`: execution, callback, validation, or verification failed
- `cancelled`: the caller cancelled the job
- `timeout`: the configured execution deadline expired

`needs_input`, `blocked`, and `stalled` retain resumable context. Continue them with `mimo_resume` and the parent `jobId`; the continuation is a new child job and inherits the parent's notification target unless explicitly overridden. `timeout` jobs with a durable checkpoint may also resume when the MiMo process is confirmed dead. Development acceptance failures with `build_failed`, `tests_failed`, `diff_check_failed`, or `delivery_contract_missing` are also resumable via Phase 2 `mimo_resume` when a checkpoint exists; `acceptance_config_missing` pauses as `needs_input`. Mid-chain `slice_failed` is resumable on the root (continues the attention slice and skips completed slices). `slice_plan_invalid` is not resumable — re-launch with a corrected objective or `batchMode` after re-planning.

### Slice chains (`batchMode`)

Write entries (`implement` and write Compose workflows) accept `batchMode`: `auto` (default), `single`, or `sliced`.

- `auto` — bounded read-only planning returns one or more slices.
- `single` — caller asserts one narrow deliverable (materialized as a one-slice chain). Requires bounded `allowedPaths`; bare repository-wide `**` is rejected at launch.
- `sliced` — require at least two slices; planning fails with `slice_plan_invalid` if the objective cannot be decomposed safely.

`allowedPaths` patterns are repository-relative: exact file (`src/app.ts`), directory prefix (`src/components`), or trailing `/**` only (`src/components/**`). Rejected: bare `**`, absolute paths, `..`, UNC paths, and mid-path globs such as `src/*.ts`.

The bridge saves the manifest at `.codex-mimo/reports/<rootJobId>.slices.json` and the durable chain at `.codex-mimo/jobs/<chainId>.chain.json`, then executes **one slice at a time**. Internal slice children omit notification targets; only the public root enqueues outbox deliveries. A failed slice finalizes the root with `slice_failed`. Standard `mimo_result` on a chain root includes `completedSlices` and `remainingSlices`.

## Progress and timeout budgets

Work requests accept three independent clocks:

| Budget | Field | Default | Measures |
| --- | --- | --- | --- |
| Effective-progress stop-loss | `progressTimeoutMs` | 5 minutes (`300_000`) | Time since the last fingerprintable useful progress event |
| Progress warning (internal) | `progressWarningMs` | 2 minutes (`120_000`) | Earlier internal warning before the stop-loss fires |
| Transport idle stop-loss | `idleTimeoutMs` | 30 minutes (`1_800_000`) | Silence since the last stdout JSONL line |
| Absolute run budget | `timeoutMs` | 30 minutes (`1_800_000`) | Total wall time since job start |

Whichever budget fires first wins. Effective-progress stop-loss is distinct from transport idle timeout: JSONL may still arrive while MiMo repeats the same non-progress output; after five minutes without new useful progress the worker writes `.codex-mimo/reports/<jobId>.checkpoint.json`, terminates the owned MiMo tree, and finalizes as immutable `stalled`. Setting `progressTimeoutMs: 0` disables effective-progress stop-loss and weakens the five-minute deliverability objective.

`mimo_status` at `standard` level exposes `lastProgressAt`, `quietSince`, and progress budgets while a job is `running`.

### Resume eligibility

| Parent status | Checkpoint required | Session reuse | Notes |
| --- | --- | --- | --- |
| `needs_input` | No | Yes when present | Caller supplies additional `task` text |
| `blocked` | No | Yes when present | Caller supplies additional `task` text |
| `stalled` | Yes | Yes when present | Checkpoint-only prompt forbids broad repository scans |
| `timeout` | Yes when no session | Checkpoint when no `sessionId` | `idle_timeout` and absolute `timeout` |
| `failed` with resumable code | Per error | Per error | `build_failed`, `tests_failed`, `diff_check_failed`, `delivery_contract_missing`, `slice_failed` (`slice_plan_invalid` requires a new job) |
| `failed` with safety code | No | No | `prompt_identity_mismatch`, `callback_session_mismatch`, `event_session_mismatch`, `write_scope_violation`, `acceptance_command_unavailable` — restart with a corrected objective, scope, or acceptance; do not resume |

Never call `mimo_resume` while `stalled_process_alive` is set on a `blocked` parent.

## Work Tools

The MCP server exposes exactly 13 tools:

| Tool | Purpose |
| --- | --- |
| `mimo_healthcheck` | Check MiMoCode availability and basic Codex CLI readiness |
| `mimo_plan` | Create a read-only plan job |
| `mimo_implement` | Create an implementation job; requires `allowWrite: true` |
| `mimo_review` | Review changes since a base ref |
| `mimo_fix_ci` | Repair failures from a log file |
| `mimo_resume` | Create a child job from a paused parent |
| `mimo_compose` | Run a registered Compose workflow |
| `mimo_status` | Read a job and notification snapshot |
| `mimo_events` | Read cursor-based compact progress |
| `mimo_wait` | Perform one attention-event wait for explicit diagnosis |
| `mimo_result` | Read a paused or terminal result |
| `mimo_cancel` | Cancel a queued or running job |
| `mimo_jobs` | List recent workspace jobs |

Every work tool returns:

```json
{
  "jobId": "...",
  "kind": "implement",
  "status": "queued",
  "actions": {
    "status": "mimo_status",
    "events": "mimo_events",
    "result": "mimo_result",
    "cancel": "mimo_cancel"
  }
}
```

The default Codex Desktop flow omits `notify` and uses a native in-chat scheduled follow-up (heartbeat) every 5 minutes: each beat may call at most one `mimo_status` at the default compact level; on `needs_input`, `blocked`, `stalled`, or a terminal status it calls at most one `mimo_result` at the default compact level, deletes the schedule, and answers from status, changed files, tests, failure, bounded plan/review summary when present, and `reportPath`. Do not call `mimo_events` or `mimo_wait` on that path. Optional App Server `notify: { type: "codex", threadId }` remains a CLI/compat history-write path: the notify worker waits on App Server `turn/completed` and starts one callback turn whose prompt already contains the prefetched public result and must not call any tool. Outbox `delivered` means that matching callback turn completed on the independent App Server connection — never that the Desktop UI refreshed. Direct user diagnostics may still use `mimo_result`.

## Result delivery and artifacts

`mimo_result` defaults to a compact delivery record: status, changed files, compact verification/acceptance stage results, failure, report path, and a bounded plan/review summary when applicable. Complete final text is not returned by default. `reportPath` is repository-relative when the artifact is inside the requested workspace. Default compact `mimo_result` JSON must not exceed 6,000 UTF-8 bytes. Acceptance failures include compact fields such as `failedStage`, failed command/tests, and a shortest-fix `suggestion`. When multiple failures occur, compact `failure.causes` keeps at most three entries (primary first); `standard` and `full` retain the complete list in `failureCauses`.

Use `level: "standard"` for bounded operator diagnostics and `level: "full"` only for explicit manual troubleshooting. `full` reads complete semantic and verification artifacts; normal Desktop heartbeat and automatic callback delivery remain compact.

Full responses inline at most 1,000,000 bytes per artifact. A larger artifact is not truncated: the result contains `artifact_too_large`, the exact artifact path, and its byte count.

Every finalized job has structural report paths. Complete semantic output is saved separately as `<jobId>.result.md`; plans additionally use `<jobId>.plan.md`; full verification stdout/stderr uses `<jobId>.verification.json`; stall checkpoints use `<jobId>.checkpoint.json`; slice chains use `<rootJobId>.slices.json` plus `.codex-mimo/jobs/<chainId>.chain.json`. Structural `.json`/`.md` reports link to these files and do not inline their content. Recognized credentials are redacted before semantic or verification artifacts are persisted and before full diagnostics are returned.

CLI `status` defaults to `standard` for humans; MCP `mimo_status` defaults to compact.

Direct `mimo_plan` and Compose `workflow: "plan"` cannot finish `completed` without a readable final result; they finish `failed` with safe `errorCode: "result_missing"` when a planning run had no readable final result.

## Notification Targets

Each job freezes at most one target when it is created from explicit `notify` input only. The launcher never reads `CODEX_THREAD_ID` from a long-lived MCP process environment.

Distinguish four independent signals:

- MiMo `session.post` — execution evidence that the MiMoCode run finished (or failed) inside the job worker.
- Codex Desktop heartbeat — native in-chat scheduled follow-up that calls `mimo_status` / `mimo_result` in the same Desktop chat.
- Codex App Server notification — optional compatibility history writeback through a frozen Codex target on an independent App Server connection; `delivered` does not mean the Desktop UI refreshed.
- Cursor companion — host stop-hook wakeup; launch without Codex `notify` and continue using the companion path.

A queued work receipt alone does not prove a Codex notification target exists unless the explicit Codex notification launch succeeded.

### Codex Desktop launch sequence (recommended)

1. Launch one work job and **omit `notify`**.
2. Return the queued receipt and `jobId`.
3. Create an in-chat scheduled follow-up / heartbeat every 5 minutes.
4. Each beat: at most one `mimo_status` at the default compact level. While `queued`/`running`, stop quietly. On `needs_input`, `blocked`, `stalled`, `completed`, `failed`, `cancelled`, or `timeout`: call at most one `mimo_result` at the default compact level, **delete/cancel/stop the heartbeat schedule**, then answer from status, changed files, tests, failure, bounded plan/review summary when present, and `reportPath`.
5. Never treat App Server `delivered` or later session-history reads as Desktop UI visibility.

### Codex App Server notify (compat / CLI)

For CLI or explicit compatibility launches, pass the current task ID:

```json
{ "notify": { "type": "codex", "threadId": "thread-id" } }
```

Read `CODEX_THREAD_ID` from the task command environment and supply it as `notify.threadId`; never store it globally. If launch fails with `Codex notification requires threadId` or a schema `threadId` required error, stop and keep `notify` on any later Codex callback attempt. This path may write a callback into session history, but `delivered` never means the Desktop renderer refreshed.

1. Windows Desktop local discovery automatically checks `%LOCALAPPDATA%\\OpenAI\\Codex\\bin` version folders (`desktop-local`) after PATH candidates. It tries newer version folders before the stable root CLI because the root CLI can be older. A protected WindowsApps Desktop `codex.exe` is not a valid standalone callback CLI.
2. `CODEX_MIMO_CODEX_BIN` remains the authoritative optional override: set it to force one runnable standalone CLI before Codex Desktop starts, then restart Codex Desktop so the plugin MCP and detached workers inherit it.
3. Read the current task-scoped `CODEX_THREAD_ID` from the task command environment and pass it explicitly as `notify.threadId`; never store it globally.
4. Run `mimo_healthcheck` or `codex-mimo doctor` and require `mimo_healthcheck.codexNotification.ok === true` before expecting App Server callbacks. This is basic CLI readiness only: its safe source can be `configured`, `path`, or `desktop-local` and it does not validate a task.
5. Launch one work job with `notify: { type: "codex", threadId: "..." }`. The target-aware launch preflight validates the selected CLI, App Server protocol, and this explicit target task before job creation. Stop model-driven polling and let the compatibility callback turn answer from the prefetched public result without tools.

If preflight failed with `codex_cli_not_found`, `codex_cli_not_executable`, or `codex_app_server_unavailable`, run `mimo_healthcheck` and configure `CODEX_MIMO_CODEX_BIN`. Preflight failure does not automatically relaunch without notify; only an explicit user choice may switch to a no-notify Desktop heartbeat or Cursor companion launch.

Target-aware preflight validates CLI launchability and the explicit task before job persistence. A successful preflight does not merge later App Server callback delivery into job execution; the durable outbox handles delivery independently after the job is created.

Diagnostic example when MiMo is healthy but Codex notification is not:

```text
MiMo ok + codexNotification.source=path + codex_cli_not_executable
→ PATH resolved a non-runnable Codex command (commonly protected WindowsApps)
→ set CODEX_MIMO_CODEX_BIN to a standalone CLI
→ restart Codex Desktop
→ require mimo_healthcheck.codexNotification.ok=true
→ retry with the same explicit notify.threadId
```

CLI users may omit `notify` intentionally or supply `--notify codex --thread-id <id>`. Cursor companion launches may omit Codex notify. Webhook and Codex notification settings remain mutually exclusive.

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

Codex App Server delivery is at-least-once across process crashes and remains a compatibility history-write path. A full notified job normally performs two system-only `thread/resume` probes: launch preflight and delivery preparation. In normal operation, each delivery attempt performs exactly one `turn/start`; the notify worker waits on `turn/completed` without calling `mimo_status`, `mimo_events`, or `mimo_wait`, and marks the outbox `delivered` only after the matching callback turn completes on that independent App Server connection. `delivered` does not mean the Desktop UI refreshed. The callback turn receives a prefetched public result and must not call tools. If the notification process crashes after `turn/start` but before callback completion is settled, the same persisted event ID can be retried and start a duplicate callback turn. The callback prompt includes that event ID and identifies the notification as a possible retry.

Webhook targets name an environment variable; secret values are never stored in job, event, log, report, or outbox files:

```json
{
  "notify": {
    "type": "webhook",
    "url": "https://receiver.example/mimo-events",
    "secretEnv": "CODEX_MIMO_WEBHOOK_SECRET"
  }
}
```

Requests include `X-Codex-Mimo-Event-Id` for receiver deduplication and `X-Codex-Mimo-Signature`, an HMAC-SHA256 of the exact body using the named secret. Receivers should deduplicate by event ID before processing.

Notification delivery is independent of job execution. Transient failures retry in the notification worker using 10 seconds, 1 minute, then 5-minute intervals for up to 30 minutes. A delivery failure is reported by `mimo_status`/`mimo_result` but never changes a successful job to failed. Expired delivery leases are reclaimed after a worker restart.

## CLI

CLI work commands also return queued JSON receipts:

```powershell
codex-mimo plan --cwd E:\project "Plan the change"
codex-mimo implement --cwd E:\project --allow-write "Implement the change"
codex-mimo review --cwd E:\project --base HEAD
codex-mimo fix-ci --cwd E:\project --file ci.log "Repair CI"
codex-mimo resume --cwd E:\project --job-id <parent-job-id> "Continue with this answer"
codex-mimo compose --cwd E:\project --workflow dev "Build the feature"
```

Controls are `status`, `events`, `wait`, `result`, `cancel`, and `jobs`, each with `--cwd` and the relevant `--job-id`/cursor flags. Notification flags are `--notify codex --thread-id ...` or `--notify webhook --url ... --secret-env ...`.

```powershell
codex-mimo status --cwd E:\project --job-id <job-id>
codex-mimo result --cwd E:\project --job-id <job-id>
codex-mimo result --cwd E:\project --job-id <job-id> --level full
```

CLI `status` defaults to `standard` for humans; MCP `mimo_status` defaults to compact.

CLI exit codes are: `0` success; `2` command, input, or schema error; and `1` runtime failure, including an unhealthy `doctor` or `healthcheck`.

## Compose Workflows

Registered workflows are `brainstorm`, `plan`, `dev`, `fix`, `fix-ci`, `execute-plan`, `review`, `parallel`, `worktree`, `merge`, and `new-skill`. Compose uses the same worker and job lifecycle as every other kind; only its prompt, workflow rules, verification, and report finalization differ. See [Compose workflows](doc/compose-workflows.md).

Prefer `acceptance.build` / `acceptance.test` / `acceptance.diffCheck` for write acceptance. Stages run fail-fast: build → test → diffCheck (deterministic self-check plus read-only MiMo review). Legacy `verification[]` remains accepted and maps to the **test stage only** — it does not satisfy build. Put scope or state prose in `task`. `dev`, `execute-plan`, and `implement` cannot complete without acceptance: missing build/test disposition at finalize pauses as `needs_input` with `acceptance_config_missing`; stage failures finish `failed` with `build_failed`, `tests_failed`, `diff_check_failed`, or `delivery_contract_missing`. Resume those codes (and checkpoint-backed stalls/timeouts) via Phase 2 `mimo_resume`. For Maven/Gradle projects, detected `mvn` / `gradle` commands resolve to repository wrappers before execution and preflight: on Windows prefer `mvnw.cmd` / `gradlew.bat`; on POSIX prefer `./mvnw` / `./gradlew`. Explicit path entries are not rewritten. Missing or non-executable commands fail before edits with `acceptance_command_unavailable`. The `plan` workflow is read-only; MiMoCode returns the plan in its final response and does not write project files. The bridge saves the complete plan to `.codex-mimo/reports/<jobId>.plan.md`; default `mimo_result` returns only a bounded summary and `reportPath`. Asking it to write a plan file ends as `read_only_violation`. A planning run with no readable final result finishes `failed` with `errorCode: "result_missing"`.

```json
{ "workflow": "plan", "task": "Plan the feature; return the plan only" }
```

```json
{ "workflow": "dev", "task": "Implement the feature", "acceptance": { "build": ["npm run build"], "test": ["npm test"], "diffCheck": true } }
```

## Runtime Files and Recovery

Runtime state is below `.codex-mimo/`:

- `jobs/<jobId>.json`: authoritative job record
- `jobs/<jobId>.log`: compact progress log
- `jobs/<jobId>.events.jsonl`: normalized raw MiMoCode events (diagnostic; not the normal result API)
- `jobs/<jobId>.signals.jsonl`: cursor-addressed signals
- `jobs/notifications.jsonl`: durable notification outbox
- `callbacks/`: allowlisted internal callback receipts without final text, raw metadata, or callback error strings
- `reports/`, `events/`, `diffs/`: Compose structural event summaries, verification, and Git artifacts. Structural `.json`/`.md` reports link to semantic artifacts (`.result.md`, `.plan.md`, `.verification.json`) and do not inline their content. The raw `jobs/<jobId>.events.jsonl` file remains a diagnostic artifact, not the normal result API.
- `inputs/`, `runtime-hooks/`: UTF-8 prompt transport and generated internal callback plugins

The per-job JSON file is authoritative; `jobs/state.json` is a rebuildable cache. Each launch starts one workspace-scoped internal supervisor, which adopts an existing physical worker owner or replaces a crashed worker while execution or delivery remains unfinished, and exits when the workspace is idle. Worker startup retries are bounded. A restarted job worker never blindly reruns an unknown process: it verifies process ownership and keeps the job `running` with its PID/identity intact while termination remains unconfirmed. Only confirmed exit, identity mismatch, or confirmed termination permits a terminal transition. Pending transitions and outbox delivery identity remain stable across restart.

## Safety

- The active CLI/MCP path relies on explicit write authorization, MiMoCode invocation settings, authenticated internal callbacks, secret-environment isolation, and post-run Git checks.
- Read-only jobs are checked against Git status, diff, untracked-file fingerprints, and HEAD changes.
- Webhook secret values are removed from the MiMoCode child environment and are not written to job, signal, report, callback, audit, or notification payload files.
- Large or non-ASCII prompts use UTF-8 attachment transport below `.codex-mimo/inputs/`.

### Execution isolation

Before the first model step, an internal hook compares the MiMoCode user query hash to the bridge prompt. On mismatch the run stops with `prompt_identity_mismatch` — not resumable; restart with the correct objective.

The JSONL primary session (first `sessionID` in stdout) binds completion. Child sessions are ignored: their `session.post` callbacks are dropped, and only the bound session can finish the job. Mismatch between JSONL and callback session yields `callback_session_mismatch`; mid-run JSONL session drift yields `event_session_mismatch`.

Write jobs with `allowedPaths` enforce scope at the hook (`write`/`edit` tools) and in a mandatory post-run audit. Out-of-scope writes or changed files finish `failed` with `write_scope_violation` (`failedStage: diff_check`). `batchMode=single` requires bounded `allowedPaths` at launch.

| Error code | Recovery |
| --- | --- |
| `prompt_identity_mismatch` | MiMo received a different query than the job objective. Restart with the correct `task`; do not `mimo_resume`. |
| `callback_session_mismatch` | Completion callback session differed from the JSONL run session. Inspect events/callback diagnostics; restart the job. |
| `event_session_mismatch` | JSONL session identity changed during the run. Restart the job. |
| `write_scope_violation` | A write or post-run audit found files outside `allowedPaths`. Tighten scope and relaunch with narrower `allowedPaths`. |
| `acceptance_command_unavailable` | Build/test command missing or not executable before edits. Supply explicit `acceptance` with a repo wrapper path, fix wrapper permissions, or install the tool on PATH. |

## Development

```powershell
npm test
npm run build
npm run lint
npm run validate:plugin
```

Real-machine smokes are separately gated:

```powershell
$env:RUN_LOCAL_MIMO_HOOK_SMOKE='1'; npm run test:smoke:mimo-hooks
$env:CODEX_MIMO_INSTALLED_PLUGIN_ROOT='C:\Users\<you>\.codex\plugins\cache\<source>\codex-mimocode\<version>'
$env:RUN_LOCAL_CODEX_NOTIFY_SMOKE='1'; npm run test:smoke:codex-notify
```

The Codex notification smoke also requires a real Codex App Server and an idle, dedicated Codex task with its injected `CODEX_THREAD_ID`. `CODEX_MIMO_INSTALLED_PLUGIN_ROOT` must be the absolute installed package root, not this source checkout; the smoke rejects a missing package or a plugin manifest version that differs from the checkout. Before removing Codex-bearing PATH directories and clearing `CODEX_MIMO_CODEX_BIN`, it freezes the resolved MiMoCode command as an absolute `CODEX_MIMO_COMMAND`, so the run deterministically exercises Desktop-local discovery even when MiMoCode and Codex share a directory. Do not run it from a task handling other work: the smoke deliberately resumes that task and reads the newest assistant response from the target session rollout after the prefetched-result callback completes. Passing that read proves three separate facts: the complete MiMo marker is present in `<jobId>.result.md`, the callback assistant response is non-empty but does not echo that marker, and exactly one callback `turn/start` reaches independent session history.
