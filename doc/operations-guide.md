# Operations Guide

## Enable The Bridge

1. Install dependencies and build:

```bash
npm install
npm run build
```

2. Verify MiMoCode is available:

```bash
node dist/cli/main.js healthcheck
```

If the package bin is linked or installed, this is equivalent:

```bash
codex-mimo healthcheck
```

3. Validate plugin metadata:

```bash
npm run validate:plugin
```

4. Confirm the plugin files are present:

```text
.codex-plugin/plugin.json
.mcp.json
skills/mimocode/SKILL.md
dist/codex/mcp-server.js
```

The MCP server is discovered through `.mcp.json` and runs `node dist/codex/mcp-server.js`.

## Runtime Model

The active implementation uses `mimo run --format json`:

- direct CLI and MCP tools use `src/mimo/mimo-runner.ts`;
- foreground Compose uses `src/compose/runner.ts`;
- background Compose uses `src/compose/job-worker.ts`, launched by `src/core/job-process.ts`;
- reports are written by `src/compose/report.ts`;
- job status and high-signal progress are stored under `.codex-mimo/jobs/`.

ACP is not part of the current runtime path. `doc/acp-message-flow.md` is reference material only.

## Dependency Checks

If `node dist/cli/main.js healthcheck` or the MCP server fails with `ERR_MODULE_NOT_FOUND`, the plugin copy cannot resolve runtime dependencies. From the plugin project root, run:

```bash
npm install
npm run build
```

For packaged plugin installs, verify the plugin cache contains runtime dependencies or a bundled build. A partial cache containing only `dist/` is not enough because generated JavaScript imports packages such as `execa`, `zod`, `minimatch`, and the MCP SDK.

## Plugin Validation Before Cache Sync

Before syncing this repository into an installed Codex plugin cache, run:

```bash
npm run build
npm run validate:plugin
```

`validate:plugin` checks `.codex-plugin/plugin.json`, `.mcp.json`, `skills/*/SKILL.md` frontmatter, and the built MCP entrypoint referenced by `.mcp.json`.

## Compose Run Supervision

Use `mimo_compose.timeoutMs` or CLI `--timeout-ms` when the caller has its own timeout. Set the bridge timeout lower than the outer timeout so `codex-mimo` can stop MiMoCode and write a failure report.

Example:

```bash
codex-mimo compose --workflow plan --timeout-ms 110000 "Create a validation plan"
```

Foreground Compose writes reports under:

```text
.codex-mimo/reports/
.codex-mimo/events/
.codex-mimo/diffs/
```

If a foreground MCP call is likely to exceed the host's tool-call timeout, use `mimo_compose` with `background: true`.

## Background Jobs

Long Compose workflows can run as persisted jobs.

Start a background job through MCP:

```json
{
  "tool": "mimo_compose",
  "arguments": {
    "cwd": "/path/to/repo",
    "workflow": "dev",
    "task": "Implement login throttling",
    "background": true,
    "wait": false,
    "timeoutMs": 1800000
  }
}
```

The launch response includes `jobId`, `signals`, `wake`, and actions for `mimo_status`, `mimo_result`, and `mimo_cancel`.

Job artifacts are stored under `.codex-mimo/jobs`:

```text
state.json
<jobId>.json
<jobId>.log
<jobId>.events.jsonl
<jobId>.signals.jsonl
```

Compose reports continue to be written under `.codex-mimo/reports`, `.codex-mimo/events`, and `.codex-mimo/diffs`.

## Progress APIs

Use `mimo_wait` when Codex can keep one MCP call open. It polls inside the MCP server until new high-signal progress appears, the job becomes terminal, or `timeoutMs` expires:

```json
{
  "tool": "mimo_wait",
  "arguments": {
    "cwd": "/path/to/repo",
    "jobId": "compose-example",
    "sinceCursor": 0,
    "minLevel": "info",
    "timeoutMs": 1800000
  }
}
```

Store the returned `nextCursor` and pass it as `sinceCursor` on the next call.

Use `mimo_events` for non-blocking incremental reads. It returns the same cursor-addressed signal shape without waiting.

Use `mimo_status` for a compact snapshot and recent log lines. Do not use it as a tight polling loop when `mimo_wait` or `mimo_events` is a better fit.

Use `mimo_result` after terminal signals such as `completed`, `failed`, `cancelled`, or `timeout`.

## Codex Heartbeat Operating Path

Use `mimo_wake` when Codex should not hold one long tool call open:

```json
{
  "tool": "mimo_wake",
  "arguments": {
    "cwd": "/path/to/repo",
    "jobId": "compose-example",
    "sinceCursor": 0,
    "minLevel": "info",
    "timeoutMs": 1800000
  }
}
```

For active jobs, `mimo_wake` returns a compact prompt and `heartbeat.arguments` draft. The heartbeat should call `mimo_wait` with those arguments, then call `mimo_result` only after an attention or terminal signal. If the wait times out and the job remains active, create another heartbeat from a fresh `mimo_wake`.

For terminal jobs, `mimo_wake` returns a `result.arguments` hint instead of `heartbeat.arguments`. Codex should call `mimo_result` directly and not create another heartbeat.

## Hook Callback And Prompt Transport

Each direct or Compose run creates a temporary MiMoCode config directory under:

```text
.codex-mimo/runtime-hooks/<invocationId>/
```

The generated hook posts `session.post` back to a local `127.0.0.1` HTTP endpoint. The bridge records callback summaries and treats missing, error, or cancelled callbacks as failure signals.

Prompts longer than 8 KB or containing non-ASCII are written as UTF-8 files under:

```text
.codex-mimo/inputs/
```

The MiMoCode message then references that file. This avoids command-line encoding issues for Chinese, Japanese, or other non-ASCII task descriptions.

## Direct Tools Are Foreground-Only

`mimo_plan`, `mimo_implement`, `mimo_review`, `mimo_fix_ci`, and `mimo_resume` run synchronously and do not accept `background` or `wait` fields. For long-running work, use `mimo_compose` with `background: true`.

`mimo_implement` requires `allowWrite: true`; otherwise it rejects before invoking MiMoCode.

## Resume Paths

`mimo_result` includes resume hints when a job has a session ID:

- `resumeHint` uses `mimo_resume_job` to create a follow-up job from a previous job.
- `directResumeHint` uses `mimo_resume` with the saved session ID.

`mimo_result` also saves finished job session metadata into `.codex-mimo/sessions.json`.

List known direct sessions:

```bash
codex-mimo sessions
```

## Disable The Bridge

### Remove The Plugin

Remove the plugin through Codex plugin management, or delete the installed plugin directory.

### Disable The MCP Server

Rename or remove `.mcp.json` to prevent the MCP server from starting:

```bash
mv .mcp.json .mcp.json.disabled
```

## Rollback

If the bridge causes problems:

1. Stop the MCP server by disabling `.mcp.json`.
2. Inspect `.codex-mimo/jobs/` for active job state.
3. Inspect `.codex-mimo/reports/`, `.codex-mimo/events/`, and `.codex-mimo/diffs/` for the latest Compose run.
4. Inspect `.codex-mimo/sessions.json` for saved sessions.
5. Cancel active jobs through `mimo_cancel` when possible.

There is no active `codex-mimo.config.json` loader in the current source tree, so deleting that file does not change runtime behavior unless a downstream wrapper has added its own config layer.

## Troubleshooting

| Problem | Action |
| --- | --- |
| `mimo not found` | Install and authenticate the MiMoCode CLI, or set `CODEX_MIMO_COMMAND` / `MIMO_COMMAND`. |
| `ERR_MODULE_NOT_FOUND` | Install runtime dependencies or use a bundled plugin build. |
| MCP tools are not visible | Verify `.mcp.json`, build output, dependencies, plugin cache, and MCP server startup logs. |
| `mimo_implement requires allowWrite=true` | Pass `allowWrite: true` only when Codex is allowed to edit the workspace. |
| Compose plan or review modified files | Treat it as a failed read-only workflow and inspect the report diff. |
| Child process remains after timeout | Use `--timeout-ms` or `mimo_compose.timeoutMs` lower than the outer timeout; cancel active jobs with `mimo_cancel`. |
| `terminationReason: host_abort` | The Codex/MCP host stopped waiting before MiMoCode completed. Re-run with `background: true`, then use `mimo_wait` or `mimo_wake`. |
| `terminationReason: process_timeout` | `codex-mimo` reached its configured MiMoCode timeout. Increase `timeoutMs` or split the task. |
| `callback_missing` or missing callback text | MiMoCode exited before the generated `session.post` hook called back. Inspect report paths and `.codex-mimo/runtime-hooks/`. |
| `eventSummary.progress > 0` but no final message | MiMoCode was active but did not finish. Inspect `eventsJsonl` and resume if a session ID exists. |
| Background job timed out, need to resume | Call `mimo_result`; use `resumeHint` or `directResumeHint` if a session ID is available. |
