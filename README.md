# Codex MiMoCode Bridge

`codex-mimo` lets Codex invoke MiMoCode as a specialist coding agent for planning, implementation, review, CI repair, and long-running Compose workflows.

The active runtime path is `mimo run --format json`. Direct commands parse MiMoCode JSONL output through `src/mimo/mimo-runner.ts`; Compose commands use a streaming runner and write reports under `.codex-mimo/`.

## Prerequisites

MiMoCode must be installed and authenticated:

```bash
mimo --version
mimo auth list
```

## Setup

```bash
npm install
npm run build
npm run validate:plugin
```

`validate:plugin` checks the plugin manifest, MCP config, skill frontmatter, and built MCP entrypoint. It does not require Python or PyYAML.

## CLI Usage

```bash
codex-mimo healthcheck
codex-mimo plan "Add login rate limiting"
codex-mimo implement "Fix failing user-session test"
codex-mimo review
codex-mimo fix-ci --file ci.log
codex-mimo resume --session ses_abc123 "Continue the remaining tests"
codex-mimo sessions
codex-mimo compose --workflow dev "Implement login throttling"
codex-mimo compose --workflow execute-plan --file doc/api-refactor-plan.md
```

The CLI `compose` command runs in the foreground and writes reports under `.codex-mimo/`. Background jobs, `mimo_wait`, and `mimo_wake` are Codex MCP tool workflows rather than standalone CLI commands.

## Compose Workflows

Use `codex-mimo compose` or the `mimo_compose` MCP tool when you want MiMoCode to run a skill-driven workflow:

```bash
codex-mimo compose --workflow brainstorm "Explore login throttling requirements"
codex-mimo compose --workflow plan "Plan login throttling"
codex-mimo compose --workflow dev "Implement login throttling"
codex-mimo compose --workflow fix "Fix intermittent session loss"
codex-mimo compose --workflow fix-ci --file ci.log
codex-mimo compose --workflow execute-plan --file doc/api-refactor-plan.md
codex-mimo compose --workflow review --since HEAD
codex-mimo compose --workflow plan --timeout-ms 110000 "Create a validation plan"
```

Supported workflows are registered in `src/compose/workflow.ts`: `brainstorm`, `dev`, `fix`, `fix-ci`, `plan`, `execute-plan`, `review`, `parallel`, `worktree`, `merge`, and `new-skill`.

Reports are written to:

```text
.codex-mimo/reports/
.codex-mimo/events/
.codex-mimo/diffs/
```

Each report includes MiMoCode events, changed files, diff stat, verification results, callback status, review text when present, and report file paths. If the caller has its own timeout, set `--timeout-ms` or MCP `timeoutMs` lower than that outer timeout so `codex-mimo` can stop MiMoCode and write a report.

## Codex Plugin Installation

The project is packaged as a Codex plugin. To install or refresh a local plugin copy:

1. Build and validate the project:

   ```bash
   npm run build
   npm run validate:plugin
   ```

2. Confirm the plugin files are present:
   - `.codex-plugin/plugin.json`
   - `.mcp.json`
   - `skills/mimocode/SKILL.md`
   - `dist/codex/mcp-server.js`

3. Restart Codex or start a new Codex thread after refreshing an installed plugin cache so the host reloads skill and MCP tool metadata.

If an installed plugin cache fails with `ERR_MODULE_NOT_FOUND`, the cache is missing runtime dependencies. Reinstall dependencies in the plugin root or use a bundled plugin build; `dist/` alone is not enough for the current NodeNext build.

## MCP Tools

The MCP server is started by `node dist/codex/mcp-server.js` through `.mcp.json` and exposes:

| Tool | Description |
| --- | --- |
| `mimo_healthcheck` | Check MiMoCode installation and auth state |
| `mimo_plan` | Create an implementation plan without editing files |
| `mimo_implement` | Implement focused code changes; requires `allowWrite: true` |
| `mimo_review` | Review the current diff for bugs and regressions |
| `mimo_fix_ci` | Fix CI failures using an attached log file |
| `mimo_resume` | Resume a previous MiMoCode session directly |
| `mimo_compose` | Run a Compose workflow, foreground or background |
| `mimo_status` | Read a current job snapshot |
| `mimo_events` | Read cursor-addressed high-signal job events without blocking |
| `mimo_wait` | Wait inside the MCP server for new high-signal job events |
| `mimo_wake` | Build a Codex heartbeat prompt for a background job |
| `mimo_result` | Return compact final output for a finished job |
| `mimo_cancel` | Cancel an active background job |
| `mimo_jobs` | List recent jobs for a workspace |
| `mimo_resume_job` | Create a follow-up job from a previous job session |

Direct tools run synchronously. Use `mimo_compose` with `background: true` for long-running work.

## Long-Running Jobs

For long Compose workflows, pass `background: true` to `mimo_compose` and receive a `jobId` immediately:

```json
{
  "cwd": "/path/to/repo",
  "workflow": "dev",
  "task": "Implement login throttling",
  "background": true,
  "wait": false,
  "timeoutMs": 1800000
}
```

Job artifacts are stored under `.codex-mimo/jobs/`:

```text
<jobId>.json
<jobId>.log
<jobId>.events.jsonl
<jobId>.signals.jsonl
state.json
```

Use `mimo_wait` when Codex can keep one MCP call open. It polls inside the MCP server and returns compact cursor-addressed signals. Store `nextCursor` and pass it as `sinceCursor` on the next wait.

Use `mimo_wake` when Codex should not hold a long tool call open. For active jobs, it returns a heartbeat-ready prompt plus `heartbeat.arguments`; for terminal jobs, it returns a `mimo_result` hint instead.

Use `mimo_status` for snapshots, `mimo_events` for non-blocking incremental reads, `mimo_result` after terminal signals, and `mimo_cancel` to stop active work.

## Runtime Notes

- `mimo run --format json` emits JSONL, not a single JSON object.
- Direct runs keep `stdin: "ignore"` so MiMoCode does not wait on inherited stdin.
- Prompts start with `Objective:`. This avoids MiMoCode treating the call as an empty interactive session.
- Prompts longer than 8 KB or containing non-ASCII are written to `.codex-mimo/inputs/*.md` and passed as `@file` context.
- Runs create temporary MiMoCode hook config under `.codex-mimo/runtime-hooks/<invocationId>/` and wait for a `session.post` callback. Missing/error/cancelled callbacks are reflected in result status.
- The active source tree does not implement ACP. See `doc/acp-message-flow.md` only as a protocol reference.

## Safety Model

`src/core/policy.ts` provides a conservative policy engine:

- Reads outside the workspace: denied
- Secret files such as `.env`, `.env.*`, private keys, `.npmrc`, and `.pypirc`: denied
- Workspace writes: ask by default
- CI/non-interactive mode: ask decisions become deny
- Destructive commands such as `rm`, `git push`, and `git reset`: denied

Current CLI/MCP execution primarily relies on MiMoCode invocation prompts, post-run checks, and MiMoCode's own permission behavior. There is no active `codex-mimo.config.json` loader in this source tree.

## Architecture

```text
Codex
  -> MCP server (src/codex/mcp-server.ts)
  -> MCP tool handlers (src/codex/tools.ts)
  -> direct mimo run or Compose runner
  -> mimo run --format json
  -> JSONL events + session.post hook callback
  -> compact result or persisted job/report artifacts
```

## Project Structure

```text
src/
  cli/       CLI entrypoint and command wrappers
  codex/     MCP server, tool schemas, compact responses, wake hints
  compose/   workflow registry, foreground runner, background worker, reports, events
  core/      policy, audit, prompt, job runtime/store/signals, sessions, terminal helpers
  git/       git status and diff capture
  mimo/      MiMo run args, JSONL capture, prompt transport, hook callback
test/        Vitest unit and smoke tests
doc/         Operations, policy, Compose workflow, ACP reference docs
skills/      Codex skill definitions
templates/   MiMoCode configuration templates
scripts/     plugin validator
```

## Usage Flow

For a new feature:

```text
1. Use `mimo_compose` with workflow `brainstorm` when requirements are fuzzy.
2. Use `mimo_plan` or workflow `plan` when you need an implementation plan.
3. Use workflow `dev` for an end-to-end development loop, or `mimo_implement` for a focused direct change.
4. Use `mimo_review` or workflow `review` to inspect the diff.
5. Run the narrowest meaningful verification, such as `npm test` or `npm run lint`.
```

For CI repair:

```bash
codex-mimo fix-ci --file ci.log
codex-mimo compose --workflow fix-ci --file ci.log
```

For resuming work:

```bash
codex-mimo sessions
codex-mimo resume --session ses_abc123 "Continue from the previous run"
```

For background MCP work, use `mimo_resume_job` when a previous job has a session ID, or use the `directResumeHint` returned by `mimo_result` with `mimo_resume`.

## Development

```bash
npm run build
npm run lint
npm test
npm run validate:plugin
```

Source is ESM-only. Keep `.js` extensions in TypeScript imports.
