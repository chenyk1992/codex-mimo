# AGENTS.md

## Project

Codex-MiMo bridge: lets Codex invoke MiMoCode as a specialist coding agent through a local CLI and Codex MCP tools.

The current implementation uses `mimo run --format json` as the active integration path. Historical ACP notes are kept as protocol reference only; there is no active `src/mimo/acp-*` implementation in this tree.

## Commands

```bash
npm run build              # tsc -p tsconfig.json; required before running CLI or MCP server
npm test                   # vitest run; all tests
npm run lint               # tsc -p tsconfig.json --noEmit
npm run validate:plugin    # validates plugin manifest, MCP config, skill frontmatter, built MCP entrypoint
```

No dedicated single-test script is configured. Filter through Vitest:

```bash
npm test -- policy.test.ts
```

## Architecture

```text
src/
  cli/main.ts              CLI entrypoint (bin: codex-mimo)
  cli/commands.ts          plan / implement / review / fix-ci / resume wrappers around mimo run

  codex/mcp-server.ts      MCP server entrypoint; registers mimo_* tools and self-starts on module load
  codex/tools.ts           MCP tool handlers and foreground/background job orchestration
  codex/tool-schemas.ts    Zod schemas for all MCP tool inputs
  codex/compact.ts         compact Compose report formatter for Codex consumption
  codex/wake.ts            heartbeat-ready wake hints for long-running jobs

  compose/workflow.ts      canonical Compose workflow registry and prompt builder
  compose/runner.ts        foreground Compose execution engine
  compose/job-worker.ts    background Compose worker entrypoint
  compose/events.ts        JSONL event parser and normalizer for MiMoCode output
  compose/report.ts        Markdown/JSON/JSONL report writer
  compose/verify.ts        verification command detection and runner
  compose/streaming-runner.ts  streaming MiMo CLI runner and process-tree termination
  compose/post-checks.ts   semantic failure and read-only workflow violation checks

  core/policy.ts           standalone file/command policy engine (minimatch globs)
  core/prompt.ts           planPrompt / implementPrompt / reviewPrompt builders
  core/paths.ts            path normalization and containment checks
  core/audit.ts            standalone JSONL audit logger with rotation
  core/sessions.ts         session persistence (.codex-mimo/sessions.json)
  core/terminal.ts         subprocess manager utility
  core/jobs.ts             shared job types, status/phase enums, response contracts
  core/job-store.ts        read/write/list/prune job state under .codex-mimo/jobs
  core/job-log.ts          append timestamped log lines and JSONL event lines
  core/job-phase.ts        infer job phase from normalized MiMo events
  core/job-render.ts       render job launch/status/result responses
  core/job-process.ts      spawn detached workers and terminate process trees
  core/job-runtime.ts      high-level lifecycle API (start, append, complete, fail, cancel)
  core/job-signals.ts      cursor-addressed high-signal job events

  git/diff.ts              git status/diff capture

  mimo/run-json.ts         builds args for `mimo run --format json`
  mimo/mimo-runner.ts      runAndCapture: execa `mimo run` with JSONL parsing and hook callback
  mimo/prompt-transport.ts large/non-ASCII prompt -> UTF-8 temp file transport
  mimo/hook-callback.ts    temporary MiMoCode session.post hook config + local HTTP callback server
```

## Active Integration Paths

- **Direct tools / CLI commands** call `mimo run --format json` through `runAndCapture()` in `src/mimo/mimo-runner.ts`.
- **Foreground Compose** calls `runMimoCliStreaming()` from `src/compose/runner.ts`, writes reports, and returns a compact result for MCP.
- **Background Compose** creates a persisted job under `.codex-mimo/jobs`, spawns `codex-mimo compose-worker`, streams JSONL into logs/events/signals, then writes the Compose report.
- **ACP** is not active in the current source tree. `doc/acp-message-flow.md` is a reference for a possible future JSON-RPC path.

## Key Quirks

- **ESM-only:** `"type": "module"` in `package.json`. Source imports must use `.js` extensions even when importing `.ts` files under NodeNext resolution.
- **MCP server self-starts:** `src/codex/mcp-server.ts` calls `startMcpServer()` at module top level. It is both a library export and a runnable entrypoint.
- **`stdin: "ignore"` for direct runs:** `runAndCapture()` must keep `stdin: "ignore"` when spawning `mimo run`; otherwise MiMoCode can wait on inherited stdin and never exit.
- **JSONL, not one JSON object:** `mimo run --format json` emits newline-delimited JSON. Direct runs parse lines in `mimo-runner.ts`; Compose runs parse through `compose/events.ts`.
- **Prompt format matters:** prompts start with `Objective:` and then explicit "execute now" instructions. Do not prepend a preamble before the objective.
- **Large/non-ASCII prompt transport:** prompts longer than 8 KB or containing non-ASCII are written to `.codex-mimo/inputs/*.md`, and the actual MiMo message points MiMoCode at that UTF-8 file.
- **Hook callback is part of success detection:** direct and Compose runs create temporary config under `.codex-mimo/runtime-hooks/<invocationId>/` and wait for a `session.post` callback on a local HTTP server. Missing/error/cancelled callbacks can turn an otherwise zero exit into failure.
- **Private types in public return signatures:** TypeScript declaration output requires exported return types to be nameable. Keep public interfaces such as `CompactComposeReport` exported when exported functions return them.
- **Verification command runner is intentionally simple:** `compose/verify.ts` splits commands on whitespace and runs them with `execa(file, args)`, not through a shell.

## Compose Workflows

The `mimo_compose` MCP tool and `codex-mimo compose` CLI command use the 11 workflow names registered in `src/compose/workflow.ts`:

| Workflow | Writes | Requires | Purpose |
| --- | --- | --- | --- |
| `brainstorm` | no | task | Clarify fuzzy requirements |
| `plan` | no | task | Generate an implementation plan from a clear requirement |
| `dev` | yes | task | Feature development loop |
| `fix` | yes | task | Bug fixing loop |
| `fix-ci` | yes | file | CI failure repair from a log |
| `execute-plan` | yes | file | Execute an approved plan |
| `review` | no | none | Review current diff |
| `parallel` | yes | task | Parallel exploration loop |
| `worktree` | yes | task | Isolated worktree-oriented workflow |
| `merge` | yes | task | Finish or merge development work |
| `new-skill` | yes | task | Create or update a Compose skill |

The workflow prompt is built by `buildComposePrompt()`. Read-only workflows are checked after the run with git status/diff snapshots; unexpected modifications fail the report.

## Job Runtime

Long-running Compose workflows can run as background jobs. Job state is persisted under `.codex-mimo/jobs/`:

- `<jobId>.json` - job record
- `<jobId>.log` - compact progress log
- `<jobId>.events.jsonl` - raw normalized MiMo event lines
- `<jobId>.signals.jsonl` - cursor-addressed high-signal events
- `state.json` - most-recent job index

**MCP job tools:**

- `mimo_compose` with `background: true` returns a `jobId` immediately.
- `mimo_status` returns the current job snapshot and recent progress lines.
- `mimo_events` returns non-blocking cursor-addressed signals.
- `mimo_wait` blocks inside the MCP server until new signals arrive, the job ends, or timeout expires.
- `mimo_wake` builds a heartbeat-ready prompt plus `heartbeat.arguments` for active jobs, or a `mimo_result` hint for terminal jobs.
- `mimo_result` returns compact final output, report paths, and resume hints when a session ID exists.
- `mimo_cancel` marks a job cancelled and attempts process-tree termination.
- `mimo_jobs` lists recent jobs.
- `mimo_resume_job` creates a child job from a previous job's MiMo session.

**CLI worker:** `codex-mimo compose-worker --job-id <id> [--cwd <path>]` runs a stored background Compose request. Normal users usually start it indirectly through `mimo_compose(background: true)`.

## Policy And Audit

`src/core/policy.ts` exposes a conservative policy engine:

- reads outside the workspace are denied;
- secret files such as `.env`, private keys, `.npmrc`, and `.pypirc` are denied;
- workspace writes default to `ask`;
- CI/non-interactive mode converts `ask` to `deny`;
- destructive commands such as `rm`, `git push`, and `git reset` are denied.

There is no current `core/config.ts` loader and no active `codex-mimo.config.json` runtime merge in this source tree. Treat policy and audit modules as reusable local primitives unless a caller explicitly wires them in.

## Testing

- Tests live under `test/` and use Vitest with `describe` / `it` / `expect` / `vi`.
- Source imports in tests use `.js` extensions, for example `import { defaultPolicy } from "../../src/core/policy.js"`.
- MCP tool tests live in `test/unit/mcp-tools/`.
- Compose/job/runtime tests live in `test/unit/compose*.test.ts`, `test/unit/job*.test.ts`, and `test/unit/core/`.
- Smoke tests that require a local MiMoCode install live in `test/smoke/`.
- There are no active ACP implementation tests in the current tree.

## Plugin Structure

- `.codex-plugin/plugin.json` - Codex plugin manifest
- `.mcp.json` - MCP server config (stdio, points to `dist/codex/mcp-server.js`)
- `skills/mimocode/SKILL.md` - skill doc for when/how Codex should call MiMoCode
- `templates/` - MiMoCode project config templates
- `scripts/validate-plugin.mjs` - local plugin validator

## Docs

- `README.md` - user-facing setup, CLI, MCP tools, and workflow overview
- `doc/policy-guide.md` - current policy engine behavior and limitations
- `doc/operations-guide.md` - enable/disable, long jobs, heartbeat path, troubleshooting
- `doc/compose-workflows.md` - Compose workflow registry and job contract
- `doc/acp-message-flow.md` - reference-only ACP protocol sketch, not current runtime
