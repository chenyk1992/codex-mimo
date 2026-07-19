---
name: mimocode
description: Use when a coding task benefits from MiMoCode planning, implementation, review, CI repair, continuation, or Compose workflows.
---

# MiMoCode Integration

MiMoCode is a specialist coding agent. Every work tool creates a persisted job and immediately returns a compact queued receipt. Codex owns task scoping, user communication, acceptance review, and final verification.

## Callback-Driven Workflow

For each delegated slice:

1. Call one work tool with the complete task and workspace.
2. Return the queued receipt to the user. Do not call `mimo_wait` after launch.
3. Rely on the callback turn created when the job needs attention or reaches a terminal state.
4. When resumed by the callback turn, call `mimo_result` with the receipt's `jobId`, then inspect relevant changes and verify independently.

Use `mimo_status`, `mimo_events`, or one `mimo_wait` only for explicit user diagnostics. Normal progress does not require a Codex tool turn.

## Expected MCP Tools (13)

Work tools:

- `mimo_plan`: plan a clear task without writing files. Required: `cwd`, `task`.
- `mimo_implement`: implement a narrow task. Required: `cwd`, `task`, `allowWrite: true`.
- `mimo_review`: review the current diff. Required: `cwd`; optional `base` defaults to `HEAD`.
- `mimo_fix_ci`: repair failures from a log. Required: `cwd`, `file`; optional `task`.
- `mimo_resume`: create a child job from a `needs_input` or `blocked` parent. Required: `cwd`, parent `jobId`, `task`.
- `mimo_compose`: run a registered workflow. Required for every request: `cwd`, `workflow`. `brainstorm`, `plan`, `dev`, `fix`, `parallel`, `worktree`, `merge`, and `new-skill` also require `task`; `fix-ci` and `execute-plan` require `file`; `review` requires neither. `fix-ci` may additionally include `task`. Optional fields where valid are `since`, `verification`, and `reportDir`.

All work tools accept optional `model`, `timeoutMs`, and one notification target:

```json
{ "notify": { "type": "codex", "threadId": "optional-explicit-thread" } }
```

or:

```json
{ "notify": { "type": "webhook", "url": "https://receiver.example/jobs", "secretEnv": "WEBHOOK_SECRET" } }
```

If Codex omits `notify`, the plugin uses the current task's injected `CODEX_THREAD_ID` when available. Never ask the user to configure that variable globally.

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
- `plan`: produce a plan from clear requirements.
- `dev`: implement a feature with TDD, verification, and review.
- `fix`: diagnose and repair a bug.
- `fix-ci`: repair CI from an attached log.
- `execute-plan`: execute an approved plan file.
- `review`: review the current diff.
- `parallel`: parallel exploration.
- `worktree`: explicit isolated-worktree work.
- `merge`: explicit integration work.
- `new-skill`: author or update a Compose skill.

## Acceptance and Context Budget

- Keep delegated slices small and provide decisive verification commands.
- Read `mimo_result` first; inspect linked reports, diffs, or events only when needed.
- Never paste raw JSONL, complete prompts, or long logs into the Codex task by default.
- After write jobs, inspect the diff and run the narrowest meaningful tests, lint, or typecheck before reporting completion.
- Use review workflows for complex or risky changes.
