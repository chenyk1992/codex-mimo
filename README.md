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
| `mimo_healthcheck` | Check MiMoCode availability |
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

The default Codex flow does not call `mimo_wait`. Codex returns the receipt, then the notification adapter resumes the original task when the job emits `needs_input`, `blocked`, or a terminal result. The resumed turn calls `mimo_result`.

## Notification Targets

Each job freezes at most one target when it is created. Resolution order is explicit `notify`, the current process's `CODEX_THREAD_ID`, then no notification.

Codex Desktop injects `CODEX_THREAD_ID` for each task. Windows users do not need to configure it, and must not set it globally: a stale global value can route a new job to an old task. An explicit Codex target remains available when needed:

```json
{ "notify": { "type": "codex", "threadId": "thread-id" } }
```

The Codex adapter initializes the App Server, resumes the frozen thread only when it is idle, and starts one compact result-handling turn.

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

## Compose Workflows

Registered workflows are `brainstorm`, `plan`, `dev`, `fix`, `fix-ci`, `execute-plan`, `review`, `parallel`, `worktree`, `merge`, and `new-skill`. Compose uses the same worker and job lifecycle as every other kind; only its prompt, workflow rules, verification, and report finalization differ. See [Compose workflows](doc/compose-workflows.md).

## Runtime Files and Recovery

Runtime state is below `.codex-mimo/`:

- `jobs/<jobId>.json`: authoritative job record
- `jobs/<jobId>.log`: compact progress log
- `jobs/<jobId>.events.jsonl`: normalized raw MiMoCode events
- `jobs/<jobId>.signals.jsonl`: cursor-addressed signals
- `jobs/notifications.jsonl`: durable notification outbox
- `reports/`, `events/`, `diffs/`: Compose artifacts

The per-job JSON file is authoritative; `jobs/state.json` is a rebuildable cache. A restarted job worker never blindly reruns an unknown process. It verifies process ownership, terminates only a confirmed owned process, then records a recoverable failure or blocked state. Pending transitions and outbox deliveries are idempotent across restart.

## Safety

- Workspace reads/writes remain subject to the conservative policy layer.
- Secret files and private keys are denied.
- Destructive commands are denied by default.
- Read-only jobs are checked against Git status, diff, and HEAD changes.
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
$env:RUN_LOCAL_CODEX_NOTIFY_SMOKE='1'; npm run test:smoke:codex-notify
```

The Codex notification smoke also requires a real Codex App Server and an idle, dedicated Codex task with its injected `CODEX_THREAD_ID`. Do not run it from a task handling other work: the smoke deliberately resumes that task and asks its callback turn to fetch `mimo_result` and write an external observation marker.
