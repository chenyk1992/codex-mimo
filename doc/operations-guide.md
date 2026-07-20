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
4. Transition to `running`, capture process identity, and execute `mimo run --format json`.
5. Persist JSONL events and wait for the internal `session.post` callback.
6. Capture Git evidence, run any verification, write reports, and classify the outcome.
7. Atomically persist the new status, attention signal, and outbox delivery.
8. Start `codex-mimo notify-worker`; the job worker does not wait for delivery.

The eight statuses are `queued`, `running`, `needs_input`, `blocked`, `completed`, `failed`, `cancelled`, and `timeout`. Only `queued` and `running` are active. `needs_input` and `blocked` are paused results with no PID and may retain `sessionId`.

## Codex Task Target

Codex Desktop injects `CODEX_THREAD_ID` into the plugin process for the current task. It is resolved once when the job is created. It is not a machine configuration setting.

Do not add `CODEX_THREAD_ID` to Windows system or user environment variables. A global value outlives its task and can misroute later completions. Use an explicit `notify: { type: "codex", threadId: "..." }` only when a caller must override the current task.

Codex delivery is at-least-once across process crashes. In normal operation, one delivery performs one `thread/resume` and one `turn/start`. If the process crashes after App Server accepts `turn/start` but before durable outbox settlement, the same persisted event ID can be retried and start a duplicate callback turn. The compact prompt exposes the event ID and warns that the notification may be a retry. Busy or temporarily unavailable tasks retry; missing or forbidden tasks are permanent failures.

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

- `mimo_status`: current job, phase, recent progress, and notification summary
- `mimo_events`: cursor-based progress for explicit diagnosis
- `mimo_wait`: one attention-event wait for an explicit diagnostic request
- `mimo_result`: partial result for paused jobs or final result for terminal jobs
- `mimo_cancel`: cancel queued/running work and terminate only its confirmed owned process
- `mimo_jobs`: list recent authoritative records

Normal Codex operation uses none of these until the callback turn; that turn calls `mimo_result`. Ordinary phase and milestone signals do not create a caller notification.

### Cursor companion zero-poll

With the Cursor companion hooks installed (`hosts/cursor/README.md`), agents must not poll MCP control tools while a job is `queued` or `running`. The companion registers each work-tool receipt on `afterMCP` and blocks inside the `stop` hook until the job needs attention or the host wait budget is exhausted.

A long `stop` hook duration while MiMoCode runs is expected — the companion waits for the job, not the agent. When the wait budget is exhausted, the watch remains on disk and the hook emits a short follow-up; the next `stop` can resume waiting. Set `CODEX_MIMO_COMPANION_WAIT_SEC` (for example `60`) to cap the host wait for a quick exhausted diagnostic instead of waiting the full job duration.

Without the companion, callers demote to stop-after-launch: report the receipt and `jobId`, then use control tools only when the user explicitly asks — at most one `mimo_wait` followed by at most one `mimo_status`, never a polling loop.

CLI exit codes are: `0` success; `2` command, input, or schema error; and `1` runtime failure, including an unhealthy `doctor` or `healthcheck`.

The gated real-Codex smoke (`RUN_LOCAL_CODEX_NOTIFY_SMOKE=1`) must run from an idle, dedicated Codex task with the task-injected `CODEX_THREAD_ID`. Its completion notification starts a real callback turn in that task, so using an active task can cause busy retries or mix smoke instructions with unrelated work. The smoke starts the packaged stdio MCP server, lets both detached workers run normally, and accepts only a `completed` result marker written by the resumed task from `mimo_result` fields; its opt-in MCP audit also requires exactly that one job-scoped `mimo_result` call and no `mimo_wait` call.

## Parent-Job Continuation

Call `mimo_resume` with a `needs_input` or `blocked` parent `jobId` and the additional task text. The parent must have a saved `sessionId`. The launcher creates a new `resume` child job, copies the parent session internally, and inherits the parent target unless the request explicitly supplies another target. Parent and child records remain independently auditable.

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

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Work remains `queued` | Inspect the job log and worker spawn permissions; stale queued records become failed |
| Restarted work remains `running` | Process exit or termination is not yet confirmed; keep the supervisor active and resolve OS permission/probe failures |
| Job completed but notification failed | Inspect `notification.lastError`; job result remains valid |
| Webhook gets duplicates | Deduplicate by `X-Codex-Mimo-Event-Id` |
| Webhook signature mismatch | Compute HMAC over the exact raw body and verify the named environment secret |
| Codex target is wrong | Remove any globally configured `CODEX_THREAD_ID`; let the current task inject it |
| Need progress for diagnosis | Read `mimo_status` or `mimo_events`; use a single `mimo_wait` only when requested |
| Job asks for information | Call `mimo_result`, collect the answer, then create a child with `mimo_resume` |

## Disable or Roll Back

Disable the MCP entry in the Codex plugin configuration or remove the installed plugin directory. Existing `.codex-mimo` records are ordinary workspace files and remain available for audit. Do not delete active job state until its owned processes have been checked.
