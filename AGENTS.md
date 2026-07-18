# AGENTS.md

Codex-MiMo bridge: lets Codex invoke MiMoCode as a specialist coding agent through a local CLI and Codex MCP tools. The active integration path is `mimo run --format json`. Historical ACP notes are kept as protocol reference only; there is no active `src/mimo/acp-*` implementation.

## Commands

```bash
npm run build              # tsc -p tsconfig.json; required before running CLI or MCP server
npm test                   # vitest run; all tests
npm run test:smoke:mimo-hooks  # vitest run test/smoke/local-mimo-hooks.test.ts (needs local mimo)
npm run test:watch         # vitest watch
npm run lint               # tsc -p tsconfig.json --noEmit
npm run validate:plugin    # plugin manifest, MCP config, skill frontmatter, built MCP entrypoint
```

No dedicated single-test script. Filter through Vitest:

```bash
npm test -- policy.test.ts
```

Public CLI commands (bin: `codex-mimo`): `plan`, `implement`, `review`, `fix-ci`, `resume`, `compose`, `status`, `events`, `wait`, `result`, `cancel`, `jobs`, `doctor`, `healthcheck`. Internal runtime commands are `job-supervisor`, `job-worker`, and `notify-worker`; see `src/cli/hints.ts` for the canonical usage line.

## Architecture

```text
src/
  cli/         main.ts (arg parsing + dispatch), commands.ts, doctor.ts, hints.ts
  codex/       mcp-server.ts (stdio MCP, self-starts), tools.ts, tool-schemas.ts, tool-names.ts
  compose/     workflow.ts (11-workflow registry), events.ts, report.ts, verify.ts, post-checks.ts
  core/        policy.ts, paths.ts, prompt.ts, audit.ts, terminal.ts,
               encoding.ts (UTF-8 process env), jobs.ts, job-definitions.ts, job-launcher.ts,
               job-store.ts, job-log.ts, job-render.ts, job-transition.ts, job-supervisor.ts,
               job-worker.ts, job-process.ts, job-signals.ts, process-lock.ts,
               public-summary.ts, worker-ownership.ts
  git/         diff.ts (status/diff capture)
  mimo/        run-json.ts (builds `mimo run --format json` args),
               streaming-runner.ts, prompt-transport.ts, hook-callback.ts
  notify/      outbox.ts, dispatcher.ts, dispatch-process.ts, worker.ts,
               webhook-adapter.ts, codex-adapter.ts, codex-app-server.ts, types.ts
```

- **All six work entries** (`plan`, `implement`, `review`, `fix-ci`, `resume`, `compose`) create persisted jobs through the shared launcher, start the workspace supervisor, and return a queued receipt.
- **The workspace supervisor** holds one physical-workspace lock and replaces crashed job/notification workers while durable work remains.
- **The unified job worker** binds the job definition, starts `mimo run --format json`, persists events/signals, requires `session.post`, finalizes verification/reporting, and writes an atomic terminal transition.
- **The notification worker** leases append-only outbox records and delivers webhook or Codex task notifications without storing webhook secrets.
- **ACP** is not active. `doc/acp-message-flow.md` is reference-only.

## Key Quirks

- **ESM-only.** `"type": "module"`. Imports must use `.js` extensions even when importing `.ts` files under NodeNext.
- **MCP server self-starts.** `src/codex/mcp-server.ts` calls `startMcpServer()` at module top level — it is both a library export and a runnable entrypoint.
- **`stdin: "ignore"` for runs.** `runMimoCliStreaming()` must keep `stdin: "ignore"` when spawning `mimo run`; otherwise MiMoCode can wait on inherited stdin and never exit.
- **JSONL, not one JSON object.** `mimo run --format json` emits newline-delimited JSON of shape `{ type, timestamp, sessionID, ...data }`. Event `type` values seen in the wild: `step_start`, `tool_use`, `step_finish`, `text`, `reasoning`, `error`. The unified worker normalizes them through `compose/events.ts`.
- **Canonical field names from `tool_use` events.** `write`/`edit`/`read` carry the path at `part.state.input.file_path` (underscore). `bash` carries the command at `part.state.input.command` and the exit code at `part.state.metadata.exit`. `sessionID` is caps in raw events; our parser also accepts `sessionId`. `parseMimoOutput` checks `file_path` first, then `filepath` / `filePath` / `path` as fallbacks for compatibility.
- **Prompt format matters.** `buildComposePrompt()` starts with `Objective: ...` then explicit instructions. Do not prepend a preamble before the objective.
- **Large/non-ASCII prompt transport.** Messages over 8 KB or with non-ASCII go to `.codex-mimo/inputs/*.md`; the actual MiMo message points MiMoCode at that UTF-8 file (`src/mimo/prompt-transport.ts`).
- **Hook callback is real and is part of success detection.** MiMoCode loads callable plugin factories from `<cwd>/.mimocode/plugin/*.{js,ts}` (or `plugin/` under the `MIMOCODE_CONFIG_DIR` we inject); each factory returns hooks such as `session.pre` and `session.post`. Our `createHookCallbackController()` starts a local HTTP server and POSTs the `session.post` payload back to it. Missing/error/cancelled callbacks can turn a zero exit into failure. Verified by `test/smoke/local-mimo-hooks.test.ts` (gated on `RUN_LOCAL_MIMO_HOOK_SMOKE=1`).
- **Public return signatures.** Declaration output requires exported return types to be nameable; exported functions must return exported interfaces.
- **Verification runner is intentionally simple.** `compose/verify.ts` splits commands on whitespace and runs with `execa(file, args)`, not through a shell. Detection fallback uses `pyproject.toml` / `Cargo.toml` / `go.mod` / `package.json` to pick a default command.
- **Windows / UTF-8.** `core/encoding.ts` wraps process env to UTF-8; PowerShell users reading `.codex-mimo/inputs/*.md` should use `Get-Content -Encoding UTF8`. Compose prompts explicitly steer MiMoCode away from `2>/dev/null`, `||`, `wc -l`, `grep`, and cp936-bound Python.

## Compose Workflows

The 11 workflows registered in `src/compose/workflow.ts` (`COMPOSE_WORKFLOW_NAMES`): `brainstorm`, `plan`, `dev`, `fix`, `fix-ci`, `execute-plan`, `review`, `parallel`, `worktree`, `merge`, `new-skill`. Each declares `writesAllowed`, `requiresTask`, `requiresFile`, and a `skillChain` used by `buildComposePrompt()`. Read-only workflows (`brainstorm`, `plan`, `review`) are checked after the run with git status/diff snapshots; unexpected modifications fail the report.

The `compose` agent itself has no `prompt` field — its behaviour comes entirely from the skill library below. Our `buildComposePrompt()` is the single instruction the agent receives for a run.

The upstream MiMo-Code compose skill bundle (`packages/opencode/src/skill/compose/.bundle/`) contains 14 skills: `ask`, `brainstorm`, `debug`, `execute`, `feedback`, `merge`, `parallel`, `plan`, `report`, `review`, `subagent`, `tdd`, `verify`, `worktree`. Our workflow `skillChain`s reference 12 of these (every one except `ask` and `report`, which no current workflow invokes directly). `new-skill` is **not** an upstream skill name; the workflow invokes `compose:execute` + `compose:verify` instead.

## Job Runtime

Every work request runs as a background job. State lives under `.codex-mimo/jobs/`:

- `<jobId>.json` — job record
- `<jobId>.log` — compact progress log
- `<jobId>.events.jsonl` — raw normalized MiMo events
- `<jobId>.signals.jsonl` — cursor-addressed high-signal events
- `state.json` — most-recent job index

Reports land in `.codex-mimo/reports/`, with events under `.codex-mimo/events/` and diffs under `.codex-mimo/diffs/`.

MCP control tools: `mimo_status`, `mimo_events`, `mimo_wait`, `mimo_result`, `mimo_cancel`, `mimo_jobs`. Normal callers do not launch workers directly; work tools start `codex-mimo job-supervisor`, which owns replacement of `job-worker` and `notify-worker`. Final transitions enqueue delivery through the notification outbox.

## Policy And Audit

`src/core/policy.ts` exposes a conservative engine: reads outside the workspace denied; secret files (`.env`, private keys, `.npmrc`, `.pypirc`) denied; workspace writes default to `ask`; CI/non-interactive converts `ask` to `deny`; destructive commands (`rm`, `git push`, `git reset`) denied. No `core/config.ts` loader exists; treat policy and audit modules as reusable local primitives unless a caller explicitly wires them in.

## Testing

- Tests live under `test/` with Vitest (`describe` / `it` / `expect` / `vi`).
- Source imports in tests use `.js` extensions, e.g. `import { defaultPolicy } from "../../src/core/policy.js"`.
- Layout: `test/unit/` (including `mcp-tools/`, `compose/`, `core/`, `cross-cutting/`), `test/smoke/` (needs a local MiMoCode install).
- No active ACP implementation tests.

## Plugin Structure

- `.codex-plugin/plugin.json` — Codex plugin manifest
- `.mcp.json` — MCP server config (stdio, points to `dist/codex/mcp-server.js`)
- `skills/mimocode/SKILL.md` — skill doc for when/how Codex should call MiMoCode
- `templates/` — MiMoCode project config templates (`mimocode.jsonc`, `agents/`, `commands/`)
- `scripts/validate-plugin.mjs` — local plugin validator

## Docs

- `README.md` — setup, CLI, MCP tools, workflow overview
- `doc/policy-guide.md` — policy engine behavior and limitations
- `doc/operations-guide.md` — job operations, notification delivery, troubleshooting
- `doc/compose-workflows.md` — Compose workflow registry and job contract
- `doc/acp-message-flow.md` — reference-only ACP sketch, not current runtime
