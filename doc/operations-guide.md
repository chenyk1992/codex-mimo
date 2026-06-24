# Operations Guide

## Enable The Bridge

1. Install dependencies and build:

```bash
npm install
npm run build
```

2. Verify MiMoCode is available:

```bash
codex-mimo healthcheck
```

3. Confirm the plugin files are present:

```text
.codex-plugin/plugin.json
.mcp.json
skills/mimocode/SKILL.md
dist/codex/mcp-server.js
```

The MCP server is discovered through `.mcp.json` and exposes the `mimo_*` tools after the plugin is installed and the server starts successfully.

## Dependency Checks

If `node dist/cli/main.js healthcheck` or the MCP server fails with `ERR_MODULE_NOT_FOUND`, the installed plugin copy cannot resolve runtime dependencies. From the plugin project root, run:

```bash
npm install
npm run build
```

For packaged plugin installs, verify the plugin cache contains a complete runtime dependency tree or a bundled build. A partial cache containing only `dist/` is not enough because the generated JavaScript imports packages such as `execa`, `zod`, and the MCP SDK.

## Compose Run Supervision

Use `mimo_compose.timeoutMs` or CLI `--timeout-ms` when the caller has its own timeout. Set the bridge timeout lower than the outer timeout so `codex-mimo` can stop MiMoCode and write a failure report.

Example:

```bash
codex-mimo compose --workflow plan --timeout-ms 110000 "Create a validation plan"
```

For long `dev` runs, redirect output to files or use the MCP tool so the report paths remain available even when the run needs review.

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
    "background": true
  }
}
```

Inspect it with `mimo_status`, retrieve final output with `mimo_result`, and cancel active work with `mimo_cancel`.

Job artifacts are stored under `.codex-mimo/jobs`. Compose reports continue to be written under `.codex-mimo/reports`, `.codex-mimo/events`, and `.codex-mimo/diffs`.

## Disable The Bridge

### Remove The Plugin

Remove the plugin through Codex plugin management, or delete the installed plugin directory.

### Disable The MCP Server

Rename or remove `.mcp.json` to prevent the MCP server from starting:

```bash
mv .mcp.json .mcp.json.disabled
```

### Disable In Marketplace Metadata

If using marketplace metadata, mark the plugin unavailable:

```json
{
  "policy": {
    "installation": "NOT_AVAILABLE"
  }
}
```

## Rollback

If the bridge causes problems:

1. Stop the MCP server by disabling `.mcp.json`.
2. Inspect `.codex-mimo/reports/` and `.codex-mimo/events/` for the latest run.
3. Inspect `.codex-mimo/sessions.json` for active sessions.
4. Remove or rename `codex-mimo.config.json` to restore default policy.

## Monitoring

Audit log path:

```text
.codex-mimo/audit.jsonl
```

Common event types:

- `session_start`
- `permission`
- `file_read`
- `file_write`
- `terminal_create`
- `session_end`

Session storage path:

```text
.codex-mimo/sessions.json
```

List sessions:

```bash
codex-mimo sessions
```

## Troubleshooting

| Problem | Action |
| --- | --- |
| `mimo not found` | Install and authenticate the MiMoCode CLI. |
| `ERR_MODULE_NOT_FOUND` | Install runtime dependencies or use a bundled plugin build. |
| MCP tools are not visible | Verify `.mcp.json`, build output, dependencies, and MCP server startup logs. |
| Permission denied | Check `codex-mimo.config.json` policy. |
| Compose plan modified files | Treat as a failed read-only run and inspect the report/diff. |
| Child process remains after timeout | Use `--timeout-ms` or `mimo_compose.timeoutMs` lower than the outer timeout. |
| Audit log is too large | Adjust `audit.maxFileSize` in config. |
| Session not found | Run `codex-mimo sessions` to list known sessions. |
| `terminationReason: host_abort` | The Codex/MCP host stopped waiting before MiMoCode completed. Re-run with `background: true`; inspect with `mimo_status` and `mimo_result`. |
| `terminationReason: process_timeout` | codex-mimo reached its configured MiMoCode timeout. Increase `timeoutMs` or split the task. |
| `eventSummary.progress > 0` but no final message | MiMoCode was active but did not finish. Inspect `eventsJsonl` and resume if a session ID exists. |
| Background job timed out, need to resume | `mimo_result` includes `directResumeHint` with the session ID. Call `mimo_resume` with that session and a continuation task. |

## Background Wait

For long workflows, prefer:

```json
{ "workflow": "plan", "task": "...", "background": true, "wait": true }
```

`wait` only waits briefly (5 seconds) for fast jobs. If the job is still running, use `mimo_status` and `mimo_result`.

## Background Prompt Transport

Background Compose jobs automatically use prompt transport for non-ASCII or long prompts. The prompt is written to a UTF-8 file under `.codex-mimo/inputs/` and passed as a file reference to MiMoCode. This prevents encoding issues with Chinese, Japanese, or other non-ASCII task descriptions in background workers.

## Direct Tools Are Foreground-Only

`mimo_plan`, `mimo_implement`, `mimo_review`, `mimo_fix_ci`, and `mimo_resume` run synchronously and do not accept `background` or `wait` fields. For long-running work, use `mimo_compose` with `background: true` instead.
