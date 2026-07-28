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

## Slice chains (`batchMode`)

Write Compose workflows (`dev`, `fix`, `fix-ci`, `execute-plan`, `parallel`, `worktree`, `merge`, `new-skill`) accept optional `batchMode`: `auto` (default), `single`, or `sliced`. Read-only workflows strip `batchMode`. When enabled, the bridge plans `.codex-mimo/reports/<rootJobId>.slices.json`, records `.codex-mimo/jobs/<chainId>.chain.json`, and runs one slice at a time under the public root job. Slice children never notify; only the root delivers. Planning failure uses `slice_plan_invalid` (re-launch after re-planning; not resumable); a failed slice uses `slice_failed` (resumable). Resume the root to continue the attention slice while skipping completed slices.

`batchMode=single` requires bounded `allowedPaths`; bare repository-wide `**` is rejected at launch. Each slice declares its own `allowedPaths` in the manifest.

## Write scope (`allowedPaths`)

Write workflows enforce repository-relative scope when `allowedPaths` is present:

| Pattern | Matches |
| --- | --- |
| `src/app.ts` | Exact file |
| `src/components` | Directory and descendants |
| `src/components/**` | Directory and descendants (trailing `/**` only) |

Rejected: bare `**`, absolute paths, `..`, UNC paths, and mid-path globs such as `src/*.ts`. Known `write`/`edit` tools are blocked at the internal hook when out of scope; a mandatory post-run audit can finish `failed` with `write_scope_violation` even when build or test stages fail first.

## Execution and Status

The common worker validates the stored request, runs write workflows with MiMoCode's `build` agent and read-only workflows with the bridge's read-only agent, captures Git evidence, creates the internal `session.post` controller, streams events, runs finalization, and transitions the job. The workflow's Compose skill chain remains the behavior source in both cases.

Compose uses the platform job statuses: `queued`, `running`, `needs_input`, `blocked`, `stalled`, `completed`, `failed`, `cancelled`, and `timeout`. Report status (`passed`, `failed`, `needs_review`, or `timeout`) is an artifact-level assessment and does not replace job status.

Compose jobs share the same timeout budgets as other work kinds: `progressTimeoutMs` (default `300_000`, five minutes of no effective progress), `progressWarningMs` (default `120_000`, two-minute internal warning), `idleTimeoutMs` (default `1_800_000`, 30 minutes of JSONL silence), and absolute `timeoutMs`. Setting `progressTimeoutMs: 0` disables effective-progress stop-loss and weakens deliverability. Call `mimo_resume` for `stalled` or checkpoint-backed `timeout` parents; stalled jobs write `.codex-mimo/reports/<jobId>.checkpoint.json`.

The work call returns a queued receipt. Codex then relies on the parent-task notification or Desktop heartbeat and calls `mimo_result` at the default compact level in the resumed turn. `mimo_status`, `mimo_events`, and one `mimo_wait` are available only for explicit diagnosis.

## Verification and development acceptance

Prefer `acceptance.build` / `acceptance.test` / `acceptance.diffCheck` for write workflows. Stages run fail-fast in order: build → test → diffCheck (deterministic self-check plus read-only MiMo review). `dev`, `execute-plan`, and `implement` cannot complete without acceptance.

| Field | Role |
| --- | --- |
| `acceptance.build` | Build commands (or host-validated `not_applicable` for recognized non-compiled trees) |
| `acceptance.test` | Targeted test commands |
| `acceptance.diffCheck` | Diff self-check + read-only MiMo review (default true) |

Legacy `verification[]` remains accepted during migration and maps to the **test stage only** — it does not satisfy build. Values are executable command strings run without a shell — not natural-language acceptance criteria. Put scope or state prose (for example `计划不修改业务源码`) in `task`, not in `verification`.

```json
{ "workflow": "dev", "task": "Implement the feature", "acceptance": { "build": ["npm run build"], "test": ["npm test"], "diffCheck": true } }
```

When neither explicit `acceptance.test` / `verification` nor workflow defaults exist, detection uses:

| Project marker | Command |
| --- | --- |
| `pyproject.toml` | `python -m pytest` |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| `package.json` | `npm test` |
| Maven (`pom.xml`) | `mvn test` (resolved to `mvnw.cmd` on Windows or `./mvnw` on POSIX when present) |
| Gradle (`build.gradle`, `build.gradle.kts`) | `gradle test` (resolved to `gradlew.bat` on Windows or `./gradlew` on POSIX when present) |

Commands are split into executable and arguments and run without a shell. Build and test stages share the same wrapper resolver; explicit path entries are not rewritten. Write jobs preflight commands before edits — missing or non-executable entries fail with `acceptance_command_unavailable`. Missing build disposition or targeted tests at finalize pauses as `needs_input` with `acceptance_config_missing`. A failed stage finishes `failed` with `build_failed`, `tests_failed`, `diff_check_failed`, or `delivery_contract_missing` while retaining execution callback evidence. Compact `mimo_result` includes the first failed stage, failed command/tests, and a shortest-fix `suggestion`; call `mimo_resume` for `build_failed`, `tests_failed`, `diff_check_failed`, or `delivery_contract_missing` via Phase 2 checkpoint resume at `.codex-mimo/reports/<jobId>.checkpoint.json`. Non-acceptance workflows may still use legacy `verification_failed` for required command failures.

## Plan workflow

The `plan` workflow remains read-only. MiMoCode returns the plan in its final response and does not write project files. During host finalization the bridge saves the complete plan to `.codex-mimo/reports/<jobId>.plan.md`. Default `mimo_result` returns only a bounded summary and `reportPath` (repository-relative report path when inside the workspace); use `level: "full"` only for explicit troubleshooting. A planning run with no readable final result finishes `failed` with `errorCode: "result_missing"`.

For Codex Desktop, omit `notify` and use an in-chat scheduled follow-up heartbeat. For CLI/compat App Server history writeback, send `notify: { type: "codex", threadId: "..." }` on the first attempt. Cursor companion and intentional no-notify launches may omit Codex notify. Outbox `delivered` does not mean the Desktop UI refreshed.

```json
{ "workflow": "plan", "task": "Plan the feature; return the plan only" }
```

## Reports

Compose finalization writes structural JSON/Markdown/event reports plus applicable semantic artifacts:

- `.codex-mimo/reports/<jobId>.result.md`
- `.codex-mimo/reports/<jobId>.plan.md` for planning workflows
- `.codex-mimo/reports/<jobId>.verification.json` when host verification ran
- `.codex-mimo/diffs/<jobId>.diff` when a diff exists

Structural reports omit model output and verification stdout/stderr; they contain paths to the separate artifacts.

## Read-Only Enforcement

`brainstorm`, `plan`, and `review` are checked after execution using Git status, diff, untracked-file fingerprints, and HEAD identity. Any change becomes `failed` with `read_only_violation`, even if MiMoCode exited successfully.

## Session isolation and safety errors

Compose jobs share the same isolation contracts as other work kinds:

- Prompt hash mismatch before the first model step → `prompt_identity_mismatch` (not resumable; restart with correct `task`).
- JSONL primary session binds completion; child-session `session.post` callbacks are ignored.
- JSONL/callback session mismatch → `callback_session_mismatch`; JSONL session drift → `event_session_mismatch`.
- Out-of-scope writes or audit failures → `write_scope_violation`.
- Missing build/test command before edits → `acceptance_command_unavailable`.

When multiple failures coexist, compact `mimo_result` keeps at most three `failure.causes`; `standard` and `full` retain the complete list.

## Paused Workflow Continuation

When Compose returns `needs_input` or `blocked` (including `acceptance_config_missing`), or a resumable acceptance failure (`build_failed`, `tests_failed`, `diff_check_failed`, `delivery_contract_missing`), or a mid-chain `slice_failed`, read the partial result and reason with `mimo_result`. Supply the answer through `mimo_resume` using the parent `jobId` (the chain root for sliced work). `slice_plan_invalid` is not resumable — start a new job after correcting the plan. The child job continues the saved MiMoCode session and/or checkpoint; ordinary resume inherits the notification target by default, while mid-chain slice resume uses a null notification target and skips completed slices.

## Notification and Recovery

Attention outcomes create one durable outbox delivery for the job's frozen Codex or webhook target. Notification retry is isolated from the Compose result. If a notification worker stops, an expired lease is reclaimed; if a job worker stops, process identity is verified before the job is failed or blocked. Neither recovery path reruns Compose blindly.
