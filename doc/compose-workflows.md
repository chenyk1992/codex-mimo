# Compose Workflows

`mimo_compose` and `codex-mimo compose` create the same background job receipt as every other work kind. Compose has no separate runtime; its job definition supplies the workflow prompt, write policy, verification, and report finalizer to the unified job worker.

## Registry

Workflow definitions live in `src/compose/workflow.ts`.

| Name | Skill chain | Writes | Input |
| --- | --- | --- | --- |
| `brainstorm` | `compose:brainstorm` | no | task |
| `plan` | `compose:plan` | no | task |
| `dev` | `compose:brainstorm -> compose:plan -> compose:tdd -> compose:verify -> compose:review` | yes | task |
| `fix` | `compose:debug -> compose:tdd -> compose:verify -> compose:feedback` | yes | task |
| `fix-ci` | `compose:debug -> compose:tdd -> compose:verify -> compose:review` | yes | file; optional task |
| `execute-plan` | `compose:execute -> compose:tdd -> compose:verify -> compose:review` | yes | file |
| `review` | `compose:review -> compose:feedback` | no | optional base via `since` |
| `parallel` | `compose:parallel -> compose:subagent -> compose:verify` | yes | task |
| `worktree` | `compose:worktree` | yes | task |
| `merge` | `compose:merge` | yes | task |
| `new-skill` | `compose:execute -> compose:verify` | yes | task |

The upstream skill bundle does not contain a skill named `compose:new-skill`; the registry intentionally maps that workflow to `compose:execute` and `compose:verify`.

## Prompt Contract

`buildComposePrompt()` begins with the objective and then names the selected workflow and ordered skill chain:

```text
Objective: <task or workflow default>

Workflow: <name> - <description>

Use these Compose skills in order: <skill chain>
```

Instructions require focused changes, action/verification/risk reporting, and PowerShell-compatible commands on Windows. Read-only workflows explicitly prohibit modifications. Large or non-ASCII prompts use UTF-8 files under `.codex-mimo/inputs/`; the MiMoCode message points at that file.

## Execution and Status

The common worker validates the stored request, builds `mimo run --format json --agent compose` arguments, captures Git evidence, creates the internal `session.post` controller, streams events, runs finalization, and transitions the job.

Compose uses the platform job statuses: `queued`, `running`, `needs_input`, `blocked`, `completed`, `failed`, `cancelled`, and `timeout`. Report status (`passed`, `failed`, `needs_review`, or `timeout`) is an artifact-level assessment and does not replace job status.

The work call returns a queued receipt. Codex then relies on the parent-task notification and calls `mimo_result` in the resumed turn. `mimo_status`, `mimo_events`, and one `mimo_wait` are available only for explicit diagnosis.

## Verification

Explicit `verification` commands take precedence over workflow defaults. When neither exists, detection uses:

| Project marker | Command |
| --- | --- |
| `pyproject.toml` | `python -m pytest` |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| `package.json` | `npm test` |

Commands are split into executable and arguments and run without a shell. A failed required command produces job status `failed` with `verification_failed` while retaining the execution callback evidence.

## Reports

Compose finalization writes:

- `.codex-mimo/reports/<jobId>.json`
- `.codex-mimo/reports/<jobId>.md`
- `.codex-mimo/events/<jobId>.jsonl`
- `.codex-mimo/diffs/<jobId>.diff` when a diff exists

Reports include the workflow, requested skills, sanitized MiMoCode arguments, event summary, Git before/after evidence, changed files, verification, callback outcome, and errors. Notification payloads contain only a compact result summary and report paths; they do not contain raw events, complete prompts, or full diffs.

## Read-Only Enforcement

`brainstorm`, `plan`, and `review` are checked after execution using Git status, diff, untracked-file fingerprints, and HEAD identity. Any change becomes `failed` with `read_only_violation`, even if MiMoCode exited successfully.

## Paused Workflow Continuation

When Compose returns `needs_input` or `blocked`, read the partial result and reason with `mimo_result`. Supply the answer through `mimo_resume` using the parent `jobId`. The child job continues the saved MiMoCode session and inherits the notification target by default.

## Notification and Recovery

Attention outcomes create one durable outbox delivery for the job's frozen Codex or webhook target. Notification retry is isolated from the Compose result. If a notification worker stops, an expired lease is reclaimed; if a job worker stops, process identity is verified before the job is failed or blocked. Neither recovery path reruns Compose blindly.
