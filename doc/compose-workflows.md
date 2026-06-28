# Compose Workflows

`codex-mimo compose` and the `mimo_compose` MCP tool start MiMoCode in Compose mode by calling `mimo run --format json --agent compose` with a workflow-specific prompt.

Workflow definitions live in `src/compose/workflow.ts`.

## Workflows

| Name | Skill chain | Writes | Requires task | Requires file | Use |
| --- | --- | --- | --- | --- | --- |
| `brainstorm` | `compose:brainstorm` | no | yes | no | Clarify fuzzy requirements |
| `dev` | `compose:brainstorm -> compose:plan -> compose:tdd -> compose:verify -> compose:review` | yes | yes | no | Feature work |
| `fix` | `compose:debug -> compose:tdd -> compose:verify -> compose:feedback` | yes | yes | no | Bug fixes |
| `fix-ci` | `compose:debug -> compose:tdd -> compose:verify -> compose:review` | yes | no | yes | CI repair from a log |
| `plan` | `compose:plan` | no | yes | no | Write implementation plan from a clear requirement |
| `execute-plan` | `compose:execute -> compose:tdd -> compose:verify -> compose:review` | yes | no | yes | Execute an approved plan |
| `review` | `compose:review -> compose:feedback` | no | no | no | Diff review |
| `parallel` | `compose:parallel -> compose:subagent -> compose:verify` | yes | yes | no | Independent subtask exploration |
| `worktree` | `compose:worktree` | yes | yes | no | Isolate work in a git worktree |
| `merge` | `compose:merge` | yes | yes | no | Finish or merge a development branch |
| `new-skill` | `compose:new-skill` | yes | yes | no | Create or update a Compose skill |

## Prompt Contract

`buildComposePrompt()` creates prompts with this shape:

```text
Objective: <task or default task>

Workflow: <name> - <description>

Use these Compose skills in order: <skill chain>

Instructions:
- Treat the Objective above as the task input for this workflow.
- Do not ask what to plan or implement unless the Objective is genuinely ambiguous.
- Keep changes minimal and focused.
- Do not commit, push, reset, or delete files.
- Record actions taken, verification evidence, and remaining risks.
- On Windows: use PowerShell-compatible commands.
```

Read-only workflows add `This workflow is read-only. Do not modify files.`

The `plan` workflow adds extra convergence rules so MiMoCode produces a plan instead of stopping at analysis.

## Foreground Execution

Foreground Compose is handled by `src/compose/runner.ts`:

1. Validate task/file requirements for the selected workflow.
2. Build the workflow prompt.
3. Apply prompt transport when the prompt is long or non-ASCII.
4. Build `mimo run --format json --agent compose ...` args.
5. Capture git status before the run.
6. Create a temporary `session.post` hook callback controller.
7. Run MiMoCode through `runMimoCliStreaming()`.
8. Capture git diff and git status after the run.
9. Run verification commands.
10. Detect semantic failures and read-only workflow violations.
11. Write Markdown, JSON, and events JSONL reports.
12. Return a compact report to Codex.

Foreground status can be `passed`, `failed`, `needs_review`, or `timeout`.

## Background Execution

Use `background: true` for long workflows such as `dev`, `fix`, `fix-ci`, `execute-plan`, and `parallel`, or for any workflow with large context.

The MCP handler creates a job record, spawns `codex-mimo compose-worker --job-id <id>`, and returns immediately unless `wait: true` is supplied.

The background worker:

1. Reads the stored job request.
2. Builds the same workflow prompt and MiMoCode args as foreground Compose.
3. Starts runtime job state.
4. Streams each MiMoCode JSONL line into job logs/events.
5. Infers phase changes and appends high-signal job signals.
6. Waits for the `session.post` hook callback.
7. Captures diff/status and runs verification.
8. Writes the Compose report.
9. Marks the job completed, failed, or cancelled. Timeouts are stored as failed jobs with `errorCode: "timeout"` and report status `timeout`.

Job tools:

- `mimo_status`
- `mimo_events`
- `mimo_wait`
- `mimo_wake`
- `mimo_result`
- `mimo_cancel`
- `mimo_jobs`
- `mimo_resume_job`

With `wait: true`, `mimo_compose` waits for the job to settle until `timeoutMs` plus a short callback grace window. If the job is still running, it returns the current status and job hints.

## Job Signals

`mimo_events` and `mimo_wait` return cursor-addressed signals from `<jobId>.signals.jsonl`.

Signal kinds include:

- `phase_changed`
- `milestone`
- `needs_input`
- `blocked`
- `verification_started`
- `verification_finished`
- `completed`
- `failed`
- `cancelled`
- `timeout`

Keep the returned `nextCursor` and pass it as `sinceCursor` on the next call. Use `minLevel` to filter `debug`, `info`, `warn`, or `error` signals.

`mimo_wait` blocks inside the MCP server until matching signals arrive, the job stops being active, or its wait timeout expires. `mimo_events` performs a non-blocking read.

## Wake Hints

`mimo_wake` builds a Codex heartbeat-ready prompt around `mimo_wait`.

For active jobs, it returns:

- a compact prompt;
- `heartbeat.arguments` for a future wakeup;
- the job id and cursor context.

For terminal jobs, it returns a `mimo_result` hint instead of heartbeat arguments.

## Reports

Every Compose run writes:

- Markdown report: `.codex-mimo/reports/<id>.md`
- JSON report: `.codex-mimo/reports/<id>.json`
- Events JSONL: `.codex-mimo/events/<id>.jsonl`
- Full diff when present: `.codex-mimo/diffs/<id>.diff`

Reports include:

- task and workflow;
- requested Compose skills;
- MiMoCode command args;
- git status before/after when captured;
- hook callback outcome;
- changed files and diff stat;
- verification results;
- review or plan text when extractable;
- timeout or error details.

## Verification

Verification commands come from explicit `verification` / `--verify` inputs first. If none are supplied, workflow defaults are used. If workflow defaults are empty, `compose/verify.ts` detects a project-level command:

| File present | Command |
| --- | --- |
| `pyproject.toml` | `python -m pytest` |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| `package.json` | `npm test` |

The runner splits commands on whitespace and executes them without a shell.

## Safety And Post-Checks

The launcher does not commit, push, reset, or delete files.

Read-only workflows are checked after the run. If a read-only workflow creates or modifies files, the run is marked failed and the report includes the violating files.

Semantic failure detection catches cases where MiMoCode appears not to have received the objective and responds with an interactive clarification prompt instead of executing the task.

## Resume

When a job has a MiMoCode session ID, `mimo_result` includes:

- `resumeHint` for `mimo_resume_job`;
- `directResumeHint` for direct `mimo_resume`.

Use these hints after failed or timed-out jobs when continuing the same MiMoCode session is useful.

## Prompt Transport

Foreground and background Compose use prompt transport for prompts longer than 8 KB or containing non-ASCII characters. The full prompt is written to `.codex-mimo/inputs/*.md`, and the MiMoCode message tells the agent to read that UTF-8 file as the task input.
