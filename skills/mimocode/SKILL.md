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

### Codex notify (callback-driven)

For Codex Desktop launches:

1. Send `notify: { type: "codex" }` on every work-tool launch. The packaged MCP server forwards task-scoped `CODEX_THREAD_ID`; never configure that variable as a Windows user or system environment value.
2. If the call returns `Codex notification requires threadId`, stop. Do not retry by omitting `notify`.
3. An explicit `threadId` is an allowed caller-supplied override when the current task ID is known:
   ```json
   { "notify": { "type": "codex", "threadId": "optional-explicit-thread" } }
   ```
4. Cursor companion launches may omit `notify` and must continue using the companion stop hook.
5. CLI users may omit `notify` intentionally or supply `--notify codex --thread-id <id>`.
6. Webhook settings and Codex settings remain mutually exclusive.

After a successful Codex notify launch:

1. Return the queued receipt to the user. Do not call `mimo_wait` after launch.
2. Rely on the callback turn created when the job needs attention or reaches a terminal state.
3. When resumed by the callback turn, call `mimo_result` with the receipt's `jobId`, then inspect relevant changes and verify independently.

A queued receipt alone does not prove a Codex notification target exists unless the explicit Codex notification launch succeeded.

Use `mimo_status`, `mimo_events`, or one `mimo_wait` only for explicit user diagnostics on any path. Normal progress does not require a caller tool turn.

## Expected MCP Tools (13)

Work tools:

- `mimo_plan`: plan a clear task without writing files. Required: `cwd`, `task`.
- `mimo_implement`: implement a narrow task. Required: `cwd`, `task`, `allowWrite: true`.
- `mimo_review`: review the current diff. Required: `cwd`; optional `base` defaults to `HEAD`.
- `mimo_fix_ci`: repair failures from a log. Required: `cwd`, `file`; optional `task`.
- `mimo_resume`: create a child job from a `needs_input` or `blocked` parent. Required: `cwd`, parent `jobId`, `task`.
- `mimo_compose`: run a registered workflow. Required for every request: `cwd`, `workflow`. `brainstorm`, `plan`, `dev`, `fix`, `parallel`, `worktree`, `merge`, and `new-skill` also require `task`; `fix-ci` and `execute-plan` require `file`; `review` requires neither. `fix-ci` may additionally include `task`. Optional fields where valid are `since`, `verification`, and `reportDir`.

`verification` is an array of executable commands (no shell). Put acceptance prose in `task`, not in `verification`. The `plan` workflow is read-only: it returns the plan in the job result via `mimo_result` and must not write plan files — asking it to save a file ends as `read_only_violation`.

```json
{ "workflow": "plan", "task": "Plan the feature; return the plan only" }
```

```json
{ "workflow": "dev", "task": "Implement the feature", "verification": ["npm test", "npm run build"] }
```

All work tools accept optional `model`, `timeoutMs`, `idleTimeoutMs`, and one notification target:

- `idleTimeoutMs`: optional idle stop-loss in milliseconds (default 30 minutes; `0` disables). Absolute `timeoutMs` is unchanged; whichever budget fires first wins.

```json
{ "notify": { "type": "codex", "threadId": "optional-explicit-thread" } }
```

or:

```json
{ "notify": { "type": "webhook", "url": "https://receiver.example/jobs", "secretEnv": "WEBHOOK_SECRET" } }
```

Webhook and Codex notification settings are mutually exclusive. Never ask the user to configure `CODEX_THREAD_ID` globally.

Control and inspection tools:

- `mimo_status`: current status and notification delivery state.
- `mimo_events`: cursor-based compact progress for diagnosis.
- `mimo_wait`: one attention-event wait for an explicit diagnostic request.
- `mimo_result`: compact result for `needs_input`, `blocked`, or a terminal job.
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
- `plan`: produce a plan from clear requirements; read-only — returns the plan in the job result, do not ask it to write plan files.
- `dev`: implement a feature with TDD, verification, and review.
- `fix`: diagnose and repair a bug.
- `fix-ci`: repair CI from an attached log.
- `execute-plan`: execute an approved plan file.
- `review`: review the current diff.
- `parallel`: parallel exploration — may need a raised `idleTimeoutMs` when subagents run long without JSONL.
- `worktree`: explicit isolated-worktree work.
- `merge`: explicit integration work.
- `new-skill`: author or update a Compose skill.

## Idle stop-loss and stall diagnosis

When MiMo stdout goes silent longer than `idleTimeoutMs`, the job worker terminates the process tree and finalizes as `timeout` with `errorCode: idle_timeout`. Treat this like any other attention terminal: wait for the callback turn (or user follow-up), then call `mimo_result` with the receipt's `jobId`.

Distinguish wakeup paths: MiMo `session.post` is execution evidence; Codex notification wakes the originating task; Cursor companion uses the host stop hook. A work receipt alone does not prove a Codex notification target exists unless the explicit Codex notification launch succeeded. Without a frozen Codex target, the terminal state is on disk only — discover it via `mimo_jobs` or an explicit user request.

For stall diagnosis only, an occasional `mimo_status` may read `idleMs` and `lastEventAt` while a job is `running`. Never poll or loop on control tools while a job is active.

## Acceptance and Context Budget

- Keep delegated slices small and provide decisive verification commands (executable strings, not natural-language acceptance criteria).
- Put state or scope prose such as `计划不修改业务源码` in `task`, not in `verification`.
- Read `mimo_result` first; inspect linked reports, diffs, or events only when needed.
- Never paste raw JSONL, complete prompts, or long logs into the Codex task by default.
- After write jobs, inspect the diff and run the narrowest meaningful tests, lint, or typecheck before reporting completion.
- Use review workflows for complex or risky changes.
