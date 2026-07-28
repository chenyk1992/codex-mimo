---
name: mimocode
description: Use when a coding task benefits from MiMoCode planning, implementation, review, CI repair, continuation, or Compose workflows.
---

# MiMoCode Integration

MiMoCode is a specialist coding agent. Every work tool creates a persisted job and immediately returns a compact queued receipt. Codex owns task scoping, user communication, acceptance review, and final verification.

## Delegation Workflow

Every work tool creates a persisted job and returns a queued receipt. How the caller waits depends on the host environment.

### Cursor with companion (recommended)

Install the Cursor companion hooks (`hosts/cursor/README.md`). For each delegated slice:

1. Call one work tool with the complete task and workspace.
2. Return the queued receipt to the user and **stop**. Do not call `mimo_status`, `mimo_events`, or `mimo_wait` while the job is `queued` or `running`.
3. The companion `stop` hook blocks until the job needs attention or reaches a terminal state, then auto-submits a short follow-up.
4. On that follow-up only, call `mimo_result` with the receipt's `jobId`, then inspect relevant changes and verify independently.

Never poll or loop on control tools while a job is `queued` or `running`.

### Cursor without companion

When companion hooks are not installed:

1. Call one work tool with the complete task and workspace.
2. Return the queued receipt and `jobId` to the user, then **stop**. Do not call control tools while the job is running.
3. If the user explicitly insists on waiting in-session: call **at most one** `mimo_wait`, then **at most one** `mimo_status` if needed. Then stop again.
4. When the job needs attention or is terminal, call `mimo_result` with the `jobId`.

Never poll or loop on control tools. At most one `mimo_wait`, then at most one `mimo_status`, when the user insists.

### Codex Desktop (recommended: in-chat heartbeat)

For Codex Desktop, **omit `notify`**. Do not pass `notify: { type: "codex", threadId: "..." }` on the default path. Desktop visibility comes from a native in-chat scheduled follow-up (heartbeat), not from an independent App Server callback connection.

1. Call one work tool with the complete task and workspace. Omit `notify`.
2. Return the queued receipt and `jobId` to the user.
3. Create an in-chat scheduled follow-up / heartbeat every 5 minutes for this `jobId`. Use this 5-minute cadence for all Desktop MiMoCode jobs; do not switch to a faster interval by default. Official Codex scheduled tasks support minute-based checks inside the current chat for long-running operations.
4. On each heartbeat beat:
   - On each Desktop heartbeat, call `mimo_status` once with the default compact level. While it returns `queued` or `running`, stop quietly. On attention or terminal status — including `needs_input`, `blocked`, `stalled`, `completed`, `failed`, `cancelled`, and `timeout` — call `mimo_result` once at the default compact level, delete the heartbeat, and answer from its status, changed files, tests, failure, bounded plan/review summary when present, and `reportPath`.
   - Do not call control tools other than that single `mimo_status` while non-terminal, and do not start extra work tools.

`mimo_result` output levels are `compact` (default), `standard` (bounded operator diagnostics), and `full` (complete saved result, plan, verification evidence, safe job log, and diff). Request `full` only for explicit manual troubleshooting; do not use it on normal heartbeat or callback paths.

Plan workflows remain read-only. MiMoCode must return the plan in its final response and must not write a project plan file. The bridge saves that final response to `.codex-mimo/reports/<jobId>.plan.md`; compact callers consume only the bounded summary and report path.
5. Never treat App Server outbox `delivered`, a background callback turn, or later `read_thread` history as proof that the Desktop UI refreshed. Those are independent from the Desktop renderer.

Repeated revisits while still running are expected heartbeat beats. After any attention or terminal outcome — including `needs_input`, `blocked`, `stalled`, `failed`, `cancelled`, and `timeout` — always delete the schedule so the chat does not keep checking a finished job.

### Codex App Server notify (compat / CLI history writeback)

App Server `notify: { type: "codex", threadId: "..." }` remains available for CLI users and explicit compatibility launches. It writes a callback turn through an independent App Server connection and may later be readable from session history. **It does not guarantee Desktop UI visibility or refresh.** Outbox `delivered` means only that the matching callback turn completed on that independent connection — never that Desktop showed the result.

When using this compatibility path:

1. Send `notify: { type: "codex", threadId: "..." }` with the current task ID:
   ```json
   { "notify": { "type": "codex", "threadId": "<current-task-id>" } }
   ```
   Read `CODEX_THREAD_ID` from the task command environment and pass it as `notify.threadId`. The packaged MCP config does not forward `CODEX_THREAD_ID`; never configure that variable as a Windows user or system environment value.
2. `mimo_healthcheck` and `codex-mimo doctor` report basic CLI readiness only. Unified discovery reports the safe source as `configured`, `path`, or Windows `desktop-local`; it tries Desktop version folders before the stable root CLI because the root CLI can be older. `CODEX_MIMO_CODEX_BIN` remains the authoritative optional override. Before creating a job, the work tool then performs target-aware preflight for the selected CLI, App Server protocol, and explicit task. Resolved Execa spawn failures (including protected WindowsApps Desktop binaries that return EPERM) map to safe preflight codes. On preflight failure, report the safe code and stop. Only an explicit user choice may switch to no-notify Desktop heartbeat or Cursor companion after seeing the diagnostic:
   - `codex_cli_not_found`: no standalone Codex CLI was resolved; configure `CODEX_MIMO_CODEX_BIN`, restart Codex Desktop, then run `mimo_healthcheck`.
   - `codex_cli_not_executable`: the resolved command cannot be spawned, including a protected WindowsApps Desktop binary; configure a standalone CLI outside WindowsApps, restart Codex Desktop, then run `mimo_healthcheck`.
   - `codex_app_server_unavailable`: the selected command failed its generic launchability/version check; run `mimo_healthcheck` and verify the configured CLI.
3. If the call returns `Codex notification requires threadId` or a schema `threadId` required error, stop and keep `notify` on any later Codex callback attempt.
4. Cursor companion launches omit Codex notify and use the companion stop hook.
5. Desktop recommended launches omit Codex notify and use the in-chat heartbeat above.
6. CLI users may omit `notify` intentionally or supply `--notify codex --thread-id <id>`.
7. Webhook settings and Codex settings remain mutually exclusive.

After a successful Codex notify launch, return the queued receipt and stop. The notify worker may start one callback turn whose prompt already contains the public job result; that callback must answer using that result and must not call any tool. `delivered` still means only that the matching callback turn completed on the independent App Server connection.

Direct user diagnostics remain unchanged: user may ask for `mimo_result`, `mimo_status`, `mimo_events`, or one `mimo_wait`; those calls are not part of automatic Desktop heartbeat delivery.

A queued receipt alone does not prove a Codex notification target exists unless the explicit Codex notification launch succeeded.

## Expected MCP Tools (13)

Work tools:

- `mimo_plan`: plan a clear task without writing files. Required: `cwd`, `task`.
- `mimo_implement`: implement a narrow task. Required: `cwd`, `task`, `allowWrite: true`. Optional `batchMode`: `auto` (default), `single`, or `sliced`. Optional `allowedPaths` (required when `batchMode=single`; bare `**` rejected).
- `mimo_review`: review the current diff. Required: `cwd`; optional `base` defaults to `HEAD`.
- `mimo_fix_ci`: repair failures from a log. Required: `cwd`, `file`; optional `task`.
- `mimo_resume`: create a child job from a `needs_input`, `blocked`, `stalled`, eligible `timeout`, or resumable-failure parent (`build_failed`, `tests_failed`, `diff_check_failed`, `delivery_contract_missing`, `slice_failed`). Required: `cwd`, parent `jobId`. `task` is required for `needs_input`/`blocked` and optional for checkpoint-backed `stalled`/`timeout`/resumable failures. For slice-chain roots, resume continues the current attention slice and skips completed slices. `slice_plan_invalid` is not resumable — re-launch with a corrected objective/`batchMode`.
- `mimo_compose`: run a registered workflow. Required for every request: `cwd`, `workflow`. `brainstorm`, `plan`, `dev`, `fix`, `parallel`, `worktree`, `merge`, and `new-skill` also require `task`; `fix-ci` and `execute-plan` require `file`; `review` requires neither. `fix-ci` may additionally include `task`. Optional fields where valid are `since`, `acceptance`, `verification`, `reportDir`, write-workflow `batchMode`, and write-workflow `allowedPaths` (required when `batchMode=single`).

`acceptance` is the preferred write-acceptance contract: `acceptance.build` (build commands), `acceptance.test` (targeted tests), and `acceptance.diffCheck` (deterministic diff self-check plus read-only MiMo review; default true). Legacy `verification[]` remains accepted and maps to the **test stage only** — it does not satisfy build. Put acceptance prose in `task`, not in `verification` or `acceptance` command arrays.

`dev`, `execute-plan`, and `implement` cannot complete without host development acceptance. Stages run fail-fast: build → test → diffCheck. Missing build disposition or targeted tests at finalize pause as `needs_input` with `acceptance_config_missing`. Stage failures finish `failed` with `build_failed`, `tests_failed`, `diff_check_failed`, or `delivery_contract_missing`. Compact `mimo_result` exposes stage outcomes plus failure fields (`failedStage`, failed command/tests, `suggestion`); resume those codes via Phase 2 `mimo_resume` and the parent checkpoint. For Maven/Gradle projects, detected `mvn` / `gradle` commands resolve to repository wrappers (`mvnw.cmd` / `./mvnw`, `gradlew.bat` / `./gradlew`) before preflight and execution; missing commands fail before edits with `acceptance_command_unavailable`.

Write workflows may set `batchMode` to `auto` (default bounded planning), `single` (one narrow deliverable), or `sliced` (require at least two slices). `batchMode=single` requires bounded `allowedPaths`; bare repository-wide `**` is rejected. Supported patterns: exact file (`src/app.ts`), directory prefix (`src/components`), or trailing `/**` only (`src/components/**`). The bridge plans a slice manifest, persists `.codex-mimo/reports/<rootJobId>.slices.json` and `.codex-mimo/jobs/<chainId>.chain.json`, and runs **one slice at a time**. Slice children omit notification targets — only the root job notifies. Planning failure finishes the root as `failed` with `slice_plan_invalid` (not resumable; re-launch after re-planning); a failed slice finishes the root as `failed` with `slice_failed` (resumable). `mimo_resume` on the root (or attention slice) continues the current slice and never relaunches completed slices. Standard `mimo_result` exposes `completedSlices` / `remainingSlices` for chain roots.

The `plan` workflow is read-only: MiMoCode must return the plan in its final response and must not write a project plan file. The bridge saves that final response to `.codex-mimo/reports/<jobId>.plan.md`; compact callers consume only the bounded summary and report path. Asking it to save a file ends as `read_only_violation`. A planning run with no readable final result finishes `failed` with `errorCode: "result_missing"`.

```json
{ "workflow": "plan", "task": "Plan the feature; return the plan only" }
```

```json
{ "workflow": "dev", "task": "Implement the feature", "acceptance": { "build": ["npm run build"], "test": ["npm test"], "diffCheck": true } }
```

All work tools accept optional `timeoutMs`, `idleTimeoutMs`, `progressWarningMs`, `progressTimeoutMs`, and one notification target. Model and provider selection are intentionally not exposed: every run inherits MiMoCode's own configuration and credentials.

- `idleTimeoutMs`: optional transport idle stop-loss in milliseconds (default 30 minutes; `0` disables). Measures silence since the last stdout JSONL line.
- `progressWarningMs`: optional internal warning before effective-progress stop-loss (default 2 minutes; `120_000`).
- `progressTimeoutMs`: optional effective-progress stop-loss in milliseconds (default 5 minutes; `300_000`). When no fingerprintable useful progress arrives within this budget, the worker writes `.codex-mimo/reports/<jobId>.checkpoint.json` and finalizes as immutable `stalled`. Setting `progressTimeoutMs: 0` disables this stop-loss and weakens the five-minute deliverability objective. This is distinct from transport `idleTimeoutMs` and absolute `timeoutMs`; whichever budget fires first wins.

```json
{ "notify": { "type": "codex", "threadId": "<current-task-id>" } }
```

or:

```json
{ "notify": { "type": "webhook", "url": "https://receiver.example/jobs", "secretEnv": "WEBHOOK_SECRET" } }
```

Webhook and Codex notification settings are mutually exclusive. Never ask the user to configure `CODEX_THREAD_ID` globally. Codex Desktop recommended launches omit `notify` and use the in-chat heartbeat instead.

Control and inspection tools:

- `mimo_status`: compact heartbeat state by default; `standard` exposes bounded live diagnostics.
- `mimo_events`: cursor-based compact progress for diagnosis.
- `mimo_wait`: one attention-event wait for an explicit diagnostic request.
- `mimo_result`: compact delivery result by default; `standard` adds key diagnostics; `full` is explicit manual troubleshooting.
- `mimo_cancel`: cancel a queued or running job.
- `mimo_jobs`: list workspace jobs.
- `mimo_healthcheck`: check the local MiMoCode installation.

Every work tool returns only this stable receipt shape:

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

## Compose Selection

- `brainstorm`: clarify requirements.
- `plan`: produce a plan from clear requirements; read-only — compact `mimo_result` returns a bounded summary and `reportPath`; use `level: "full"` only for explicit troubleshooting.
- `dev`: implement a feature with TDD and ordered development acceptance (build → test → diffCheck); cannot complete without acceptance.
- `fix`: diagnose and repair a bug.
- `fix-ci`: repair CI from an attached log.
- `execute-plan`: execute an approved plan file.
- `review`: review the current diff.
- `parallel`: parallel exploration — may need a raised `idleTimeoutMs` when subagents run long without JSONL.
- `worktree`: explicit isolated-worktree work.
- `merge`: explicit integration work.
- `new-skill`: author or update a Compose skill.

## Idle stop-loss and stall diagnosis

When MiMo stdout goes silent longer than `idleTimeoutMs`, the job worker terminates the process tree and finalizes as `timeout` with `errorCode: idle_timeout`. Treat this like any other attention terminal: on Desktop, the next heartbeat should call `mimo_result` once, delete the schedule, and answer; for explicit App Server notify launches, wait for the compatibility callback turn (which already carries the public result) or an explicit user follow-up that may call `mimo_result` with the receipt's `jobId`.

Effective-progress stop-loss is separate from transport idle timeout. JSONL may still arrive while MiMo repeats non-progress output. After `progressTimeoutMs` (default five minutes) without fingerprintable useful progress, the worker writes `.codex-mimo/reports/<jobId>.checkpoint.json`, terminates the owned MiMo tree, and finalizes as immutable `stalled`. Compact `mimo_result` then includes `attention.kind: "stalled"`, a bounded reason, optional `lastCommand`, and `attention.resume` pointing at `mimo_resume`. Continue with `mimo_resume` and the parent `jobId`; checkpoint-only prompts forbid broad repository scans.

Distinguish wakeup paths: MiMo `session.post` is execution evidence; Codex Desktop recommended wakeup is the in-chat heartbeat; Codex App Server notification is compatibility history writeback on an independent connection and does not prove Desktop UI visibility; Cursor companion uses the host stop hook. A work receipt alone does not prove a Codex notification target exists unless the explicit Codex notification launch succeeded. Without a frozen Codex target, the terminal state is on disk only — discover it via Desktop heartbeat, `mimo_jobs`, or an explicit user request.

For stall diagnosis only, an occasional `mimo_status` may read `idleMs`, `lastEventAt`, `lastProgressAt`, `quietSince`, and `processAlive` while a job is `running`. Never poll or loop on control tools inside a single Desktop turn; the heartbeat schedule owns revisits.

## Execution isolation and safety

Before the first model step, an internal hook verifies the MiMo user query matches the bridge prompt. On mismatch the job fails with `prompt_identity_mismatch` — **not resumable**; restart with the correct objective.

The JSONL primary session (first `sessionID` in stdout) binds job completion. Child-session `session.post` callbacks are ignored. Session mismatch errors: `callback_session_mismatch` (callback vs JSONL), `event_session_mismatch` (JSONL drift mid-run).

Write jobs with `allowedPaths` block out-of-scope `write`/`edit` at the hook and in a mandatory post-run audit (`write_scope_violation`). Tighten scope and relaunch rather than resuming.

| Error code | Action |
| --- | --- |
| `prompt_identity_mismatch` | Restart with correct `task`; do not `mimo_resume` |
| `callback_session_mismatch` | Inspect events/callback diagnostics; restart |
| `event_session_mismatch` | Restart the job |
| `write_scope_violation` | Relaunch with narrower `allowedPaths` |
| `acceptance_command_unavailable` | Supply explicit `acceptance` with repo wrapper path or install the tool |

When multiple failures coexist, compact `mimo_result` keeps at most three `failure.causes`; use `level: "standard"` or `level: "full"` for the complete list.

## Acceptance and Context Budget

- Keep delegated slices small and prefer `acceptance.build` / `acceptance.test` / `acceptance.diffCheck` (executable strings, not natural-language acceptance criteria). Legacy `verification[]` maps to the test stage only.
- `dev`, `execute-plan`, and `implement` cannot complete without acceptance; treat `acceptance_config_missing` as `needs_input` and resumable stage codes (`build_failed`, `tests_failed`, `diff_check_failed`, `delivery_contract_missing`) via `mimo_resume`.
- Put state or scope prose such as `计划不修改业务源码` in `task`, not in `verification`.
- Read `mimo_result` at the default compact level first; use `reportPath` and linked artifacts only when needed. Reports stay structural and omit model output. Compact acceptance failures include `failedStage`, failed command/tests, and a shortest-fix `suggestion`.
- Never paste raw JSONL, complete prompts, or long logs into the Codex task by default.
- After write jobs, inspect the diff and run the narrowest meaningful tests, lint, or typecheck before reporting completion.
- Use review workflows for complex or risky changes.
