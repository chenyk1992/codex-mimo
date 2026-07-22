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
- `completed`: execution and required verification succeeded
- `failed`: execution, callback, validation, or verification failed
- `cancelled`: the caller cancelled the job
- `timeout`: the configured execution deadline expired

`needs_input` and `blocked` retain the MiMoCode session. Continue them with `mimo_resume` and the parent `jobId`; the continuation is a new child job and inherits the parent's notification target unless explicitly overridden.

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

The default Codex flow does not call `mimo_status`, `mimo_events`, or `mimo_wait` after launch. Codex returns the receipt; the notify worker waits on App Server `turn/completed` without model polling and starts one callback turn when the job emits `needs_input`, `blocked`, or a terminal result. That callback turn calls `mimo_result` once and reads `mimo_result.output`. Outbox `delivered` means the matching callback turn completed, not merely that App Server accepted `turn/start`.

## Result privacy boundary

Final assistant text is available only from an explicit `mimo_result` read as `mimo_result.output`. Status, job lists, signals, notifications, and Compose reports remain intentionally compact and structural: they omit model output. Operators should not expect a plan body in `.codex-mimo/reports/*.md`. The raw `jobs/<jobId>.events.jsonl` file remains a diagnostic artifact, not the normal result API.

Direct `mimo_plan` and Compose `workflow: "plan"` cannot finish `completed` without a readable final result; they finish `failed` with safe `errorCode: "result_missing"` when a planning run had no readable final result.

## Notification Targets

Each job freezes at most one target when it is created from explicit `notify` input only. The launcher never reads `CODEX_THREAD_ID` from a long-lived MCP process environment.

Distinguish three independent signals:

- MiMo `session.post` — execution evidence that the MiMoCode run finished (or failed) inside the job worker.
- Codex notification — wakes the originating Codex Desktop task through the frozen Codex target.
- Cursor companion — host stop-hook wakeup; launch without Codex `notify` and continue using the companion path.

A queued work receipt alone does not prove a Codex notification target exists unless the explicit Codex notification launch succeeded.

For Codex Desktop, pass the current task ID explicitly on every work-tool launch:

```json
{ "notify": { "type": "codex", "threadId": "thread-id" } }
```

Read `CODEX_THREAD_ID` from the task command environment and supply it as `notify.threadId`; never store it globally. If launch fails with `Codex notification requires threadId` or a schema `threadId` required error, stop and keep `notify` on any later Codex callback attempt.

### Codex Desktop launch sequence

1. Windows Desktop local discovery automatically checks `%LOCALAPPDATA%\\OpenAI\\Codex\\bin` version folders (`desktop-local`) after PATH candidates. It tries newer version folders before the stable root CLI because the root CLI can be older. A protected WindowsApps Desktop `codex.exe` is not a valid standalone callback CLI.
2. `CODEX_MIMO_CODEX_BIN` remains the authoritative optional override: set it to force one runnable standalone CLI before Codex Desktop starts, then restart Codex Desktop so the plugin MCP and detached workers inherit it.
3. Read the current task-scoped `CODEX_THREAD_ID` from the task command environment and pass it explicitly as `notify.threadId`; never store it globally.
4. Run `mimo_healthcheck` or `codex-mimo doctor` and require `mimo_healthcheck.codexNotification.ok === true` before expecting callbacks. This is basic CLI readiness only: its safe source can be `configured`, `path`, or `desktop-local` and it does not validate a task.
5. Launch one work job with `notify: { type: "codex", threadId: "..." }`. The target-aware launch preflight validates the selected CLI, App Server protocol, and this explicit target task before job creation. Stop polling and let the callback turn call `mimo_result` and consume `mimo_result.output`.

If preflight failed with `codex_cli_not_found`, `codex_cli_not_executable`, or `codex_app_server_unavailable`, run `mimo_healthcheck` and configure `CODEX_MIMO_CODEX_BIN`. Preflight failure does not automatically relaunch without notify; only an explicit user choice may switch to a no-notify or Cursor companion launch.

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
| `codex_turn_interrupted` | Callback turn ended interrupted | Allow durable retry. |
| `codex_turn_failed` | Callback turn failed | Allow durable retry; inspect only after repeated failure. |
| `codex_turn_timeout` | Five-minute callback budget expired | Check task/tool blockage before retry exhaustion. |

Codex delivery is at-least-once across process crashes. A full notified job normally performs two system-only `thread/resume` probes: launch preflight and delivery preparation. Each delivery attempt performs exactly one `turn/start`; the notify worker waits on `turn/completed` without calling `mimo_status`, `mimo_events`, or `mimo_wait`, and marks the outbox `delivered` only after the matching callback turn completes. If the notification process crashes after `turn/start` but before callback completion is settled, the same persisted event ID can be retried and start a duplicate callback turn. The callback prompt includes that event ID and identifies the notification as a possible retry; repeated `mimo_result` reads remain read-only.

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

CLI exit codes are: `0` success; `2` command, input, or schema error; and `1` runtime failure, including an unhealthy `doctor` or `healthcheck`.

## Compose Workflows

Registered workflows are `brainstorm`, `plan`, `dev`, `fix`, `fix-ci`, `execute-plan`, `review`, `parallel`, `worktree`, `merge`, and `new-skill`. Compose uses the same worker and job lifecycle as every other kind; only its prompt, workflow rules, verification, and report finalization differ. See [Compose workflows](doc/compose-workflows.md).

`verification` holds executable commands run without a shell — not natural-language acceptance criteria. Put scope or state prose in `task`. The `plan` workflow is read-only; read the plan from an explicit `mimo_result` as `mimo_result.output`. Asking it to write a plan file ends as `read_only_violation`. A planning run with no readable final result finishes `failed` with `errorCode: "result_missing"`.

```json
{ "workflow": "plan", "task": "Plan the feature; return the plan only" }
```

```json
{ "workflow": "dev", "task": "Implement the feature", "verification": ["npm test", "npm run build"] }
```

## Runtime Files and Recovery

Runtime state is below `.codex-mimo/`:

- `jobs/<jobId>.json`: authoritative job record
- `jobs/<jobId>.log`: compact progress log
- `jobs/<jobId>.events.jsonl`: normalized raw MiMoCode events (diagnostic; not the normal result API)
- `jobs/<jobId>.signals.jsonl`: cursor-addressed signals
- `jobs/notifications.jsonl`: durable notification outbox
- `callbacks/`: allowlisted internal callback receipts without final text, raw metadata, or callback error strings
- `reports/`, `events/`, `diffs/`: Compose structural event summaries, verification, and Git artifacts (reports intentionally omit model output; do not expect a plan body in `reports/*.md`)
- `inputs/`, `runtime-hooks/`: UTF-8 prompt transport and generated internal callback plugins

The per-job JSON file is authoritative; `jobs/state.json` is a rebuildable cache. Each launch starts one workspace-scoped internal supervisor, which adopts an existing physical worker owner or replaces a crashed worker while execution or delivery remains unfinished, and exits when the workspace is idle. Worker startup retries are bounded. A restarted job worker never blindly reruns an unknown process: it verifies process ownership and keeps the job `running` with its PID/identity intact while termination remains unconfirmed. Only confirmed exit, identity mismatch, or confirmed termination permits a terminal transition. Pending transitions and outbox delivery identity remain stable across restart.

## Safety

- The active CLI/MCP path relies on explicit write authorization, MiMoCode invocation settings, authenticated internal callbacks, secret-environment isolation, and post-run Git checks.
- Read-only jobs are checked against Git status, diff, untracked-file fingerprints, and HEAD changes.
- Webhook secret values are removed from the MiMoCode child environment and are not written to job, signal, report, callback, audit, or notification payload files.
- Large or non-ASCII prompts use UTF-8 attachment transport below `.codex-mimo/inputs/`.

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

The Codex notification smoke also requires a real Codex App Server and an idle, dedicated Codex task with its injected `CODEX_THREAD_ID`. `CODEX_MIMO_INSTALLED_PLUGIN_ROOT` must be the absolute installed package root, not this source checkout; the smoke rejects a missing package or a plugin manifest version that differs from the checkout. Before removing Codex-bearing PATH directories and clearing `CODEX_MIMO_CODEX_BIN`, it freezes the resolved MiMoCode command as an absolute `CODEX_MIMO_COMMAND`, so the run deterministically exercises Desktop-local discovery even when MiMoCode and Codex share a directory. Do not run it from a task handling other work: the smoke deliberately resumes that task and asks its callback turn to call `mimo_result` once and copy its exact result fields into an external observation marker.
