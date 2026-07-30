---
name: mimocode
description: Use when a coding task benefits from MiMoCode planning, implementation, review, CI repair, continuation, or Compose workflows.
---

# MiMoCode Integration

MiMoCode is a specialist coding agent. Codex owns task scoping, user communication, acceptance review, and final verification. Every work tool creates a persisted background job and immediately returns a compact queued receipt.

## Core Rules

1. Make one complete work-tool call. Include the objective, bounded scope, non-goals, allowed paths, executable acceptance commands, expected artifact paths, and success criteria.
2. Do not poll a running job. Return the queued receipt and let the host wake the task.
3. Use the default compact `mimo_status` and compact `mimo_result`. Read `standard`, `full`, raw JSONL, complete logs, saved reports, or full diffs only for a specific diagnostic or high-risk review.
4. Do not start another work job for the same objective while one is active.
5. After a write job, accept structured MiMo build/test evidence, inspect changed files and diff statistics, review risk-sensitive logic, and run only the narrowest meaningful independent check.
6. Resume with incremental information only. Do not repeat the original task, prior discussion, or complete logs.

## Expected MCP Tools (13)

Choose one work tool:

| Need | Tool | Required input |
| --- | --- | --- |
| Read-only plan | `mimo_plan` | `cwd`, complete `task` |
| Narrow implementation | `mimo_implement` | `cwd`, complete `task`, `allowWrite: true`, acceptance |
| Current-diff review | `mimo_review` | `cwd`; optional `base` |
| Repair from a CI log | `mimo_fix_ci` | `cwd`, log `file`, host acceptance; optional task |
| Continue saved work | `mimo_resume` | `cwd`, parent `jobId`; optional acceptance/scope overrides |
| Registered Compose workflow | `mimo_compose` | `cwd`, `workflow`, workflow-specific task/file |

Control tools are `mimo_status`, `mimo_events`, `mimo_wait`, `mimo_result`, `mimo_cancel`, `mimo_jobs`, and `mimo_healthcheck`. Normal delivery uses only compact `mimo_status` and compact `mimo_result`; use the others only for explicit user requests or targeted diagnosis.

## Complete Write Request

For `mimo_implement` and write Compose workflows, provide:

- A single objective and success criteria.
- `allowedPaths` plus explicit non-goals. `batchMode: "single"` requires bounded paths; bare `**` is rejected.
- `acceptance.build`, `acceptance.test`, and `acceptance.diffCheck`.
- Bounded `acceptance.artifactPaths` for expected workspace-local build/test outputs.

Development acceptance is ordered and fail-fast: build → targeted test → diff check. `implement`, `dev`, `execute-plan`, and native `mimo_fix_ci` cannot complete without acceptance. Missing acceptance pauses before edits with `acceptance_config_missing`; resume may supply `acceptance` and replace inherited `allowedPaths`. Legacy `verification[]` maps only to the test stage and does not satisfy build.

Choose `batchMode` deliberately:

| Mode | Use when |
| --- | --- |
| `single` | One narrow deliverable with predictable bounded paths; lowest coordination overhead |
| `auto` | Scope may need bounded slicing; default |
| `sliced` | A known large cross-module task needs at least two sequential slices |

Do not force `single` when scope is uncertain. Sliced work runs one slice at a time and reports through the root job only.

## Codex Desktop Default Delivery

For Codex Desktop, omit `notify`; do not pass App Server Codex notify on the default path.

1. Call one work tool with the complete request.
2. Return the queued receipt and `jobId`.
3. Create one in-chat scheduled follow-up / heartbeat every 5 minutes for that job.
4. On each heartbeat, call `mimo_status` once at the default compact level. If still `queued` or `running`, stop quietly.
5. On any attention or terminal state, call `mimo_result` once at the default compact level and use its `reportPath` (saved report path), then delete the heartbeat. This covers `needs_input`, `blocked`, `stalled`, `completed`, `failed`, `cancelled`, and `timeout`.

Never call `mimo_events` or `mimo_wait` as part of the automatic Desktop path. Never request `mimo_status` or `mimo_result` at `standard`/`full` on a routine heartbeat. Manual troubleshooting may use `level: "full"` when a concrete question requires it.

## Final Verification

Treat compact results as the delivery summary, not as permission to skip review. Match independent verification to risk:

- Inspect changed files and `git diff --stat`.
- Read core logic, security-sensitive files, and unexpected paths.
- Run the narrowest critical test, lint, or typecheck not already covered by trustworthy evidence.
- Escalate to deeper review only when change detection is partial, sensitive files changed, the diff is large, or acceptance failed.

Report the result, changed files, tests, remaining risks, and `reportPath`. Do not load `.result.md`, `.verification.json`, JSONL, or the full diff merely to restate the compact result.

## Read References Only When Needed

- [Desktop delivery details](references/desktop-delivery.md): heartbeat edge cases and plan delivery.
- [Cursor delivery](references/cursor-delivery.md): companion and no-companion wake paths.
- [App Server notify](references/app-server-notify.md): explicit CLI compatibility/history writeback.
- [Recovery and errors](references/recovery-and-errors.md): `mimo_resume`, acceptance failures, scope and session errors.
- [Compose workflows](references/compose-workflows.md): workflow selection and slice-chain behavior.
- [Diagnostics](references/diagnostics.md): output levels, timeouts, stalls, reports, and targeted investigation.
