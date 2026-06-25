# AGENTS.md

## Project

Codex-MiMo bridge — lets Codex invoke MiMoCode as a specialist coding agent via CLI or MCP.

## Commands

```bash
npm run build        # tsc — required before running CLI or MCP server
npm test             # vitest run — all unit tests
npm run lint         # tsc --noEmit — typecheck only
```

No single-test shortcut configured. Filter with: `npm test -- policy.test.ts`

## Architecture

```
src/
  cli/main.ts           CLI entrypoint (bin: codex-mimo)
  cli/commands.ts       plan / implement / review wrappers around mimo run
  codex/mcp-server.ts   MCP server entrypoint (stdio, run via node dist/codex/mcp-server.js)
  codex/tools.ts        MCP tool handlers (mimo_plan, mimo_implement, mimo_review, ...)
  codex/tool-schemas.ts Zod schemas for all MCP tool inputs
  codex/compact.ts      compact report formatter for Codex consumption
  core/policy.ts        file/command policy engine (minimatch globs)
  core/config.ts        loads codex-mimo.config.json, merges with defaults
  core/prompt.ts        planPrompt / implementPrompt / reviewPrompt builders
  core/paths.ts         path normalization and containment checks
  core/audit.ts         JSONL audit logger with rotation
  core/sessions.ts      session persistence (.codex-mimo/sessions.json)
  core/terminal.ts      subprocess manager for ACP terminal requests
  core/jobs.ts          shared job types, status/phase enums, compact response types
  core/job-store.ts     read/write/list/prune job state under .codex-mimo/jobs
  core/job-log.ts       append timestamped log lines and JSONL event lines
  core/job-phase.ts     infer job phase from normalized MiMo events
  core/job-render.ts    render status, result, launch, cancellation, list responses
  core/job-process.ts   spawn detached workers and terminate process trees
  core/job-runtime.ts   high-level lifecycle API (start, append, complete, fail)
  compose/workflow.ts   compose workflow prompt builder + workflow registry
  compose/workflow-names.ts  canonical workflow name list (11 workflows)
  compose/runner.ts     compose workflow execution engine
  compose/events.ts     JSONL event parser for mimo output
  compose/report.ts     compose report writer (markdown + JSON)
  compose/verify.ts     verification command runner
  compose/streaming-runner.ts  streaming MiMo CLI runner with normalized events
  compose/job-worker.ts worker entrypoint for background Compose jobs
  git/diff.ts           git diff capture
  git/status.ts         git status capture
  mimo/acp-client.ts    JSON-RPC client (line-framed, request/response correlation)
  mimo/acp-bridge.ts    full ACP lifecycle: init → session/new → prompt, policy enforcement
  mimo/acp-process.ts   AcpProcess wrapper (execa spawn + write/stop)
  mimo/acp-types.ts     TypeScript types for ACP JSON-RPC messages
  mimo/acp-updates.ts   convert ACP session updates to normalized events
  mimo/run-json.ts      builds args for `mimo run --format json`
  mimo/mimo-runner.ts   runAndCapture: execa `mimo run` with JSONL parsing
  mimo/prompt-transport.ts  large/non-ASCII prompt → temp file transport
```

Two integration paths:
- **MVP**: CLI calls `mimo run --format json` via execa (mimo-runner.ts)
- **ACP**: AcpBridge launches `mimo acp`, speaks JSON-RPC over stdio (acp-*.ts)

## Key Quirks

- **ESM-only**: `"type": "module"` in package.json. All imports must use `.js` extensions even for `.ts` source files (NodeNext resolution).
- **execa v9**: Use `type Subprocess` (not `ExecaChildProcess` which doesn't exist in v9).
- **stdin: "ignore"**: CLI commands that spawn `mimo run` MUST set `stdin: "ignore"` in execa options. Without this, mimo waits for stdin and the process never exits.
- **mimo run --format json** outputs JSONL (newline-delimited JSON), not a single JSON object.
- **MCP server self-starts**: `mcp-server.ts` calls `startMcpServer()` at module top level — it's both a library export and a runnable entrypoint.
- **Prompt format matters**: MiMoCode enters interactive clarification mode unless prompts start with `Objective:` followed by the task. See `core/prompt.ts` — all three prompt builders use this pattern. Never prepend preamble before the objective.
- **Private types in public return signatures**: TypeScript requires exported function return types to be nameable. If a function returns an interface, that interface must be exported even if no external consumer uses it. Demoting `CompactComposeReport` to private caused a build error.
- **Large prompt transport**: Prompts >8KB or containing non-ASCII are written to `.codex-mimo/inputs/` as temp files. The message becomes a `@file` reference. See `mimo/prompt-transport.ts`.

## Compose Workflows

The `mimo_compose` MCP tool runs orchestrated workflows. 11 workflow names are registered in `compose/workflow-names.ts`:

| Workflow | Purpose |
|----------|---------|
| brainstorm | Explore intent and requirements before implementation |
| plan | Generate implementation plan from spec |
| dev | Full development cycle (brainstorm → plan → implement → verify) |
| fix | Bug fix workflow |
| fix-ci | Fix CI failures |
| execute-plan | Execute a written plan with review checkpoints |
| review | Code review |
| parallel | Run independent tasks concurrently |
| worktree | Isolated workspace for feature work |
| merge | Integration and merge guidance |
| new-skill | Create new MiMoCode skills |

Each workflow maps to one or more compose skills (defined in `skills/mimocode/SKILL.md`). The compose runner builds prompts via `buildComposePrompt()` in `compose/workflow.ts`.

## Job Runtime

Long-running Compose workflows can run as background jobs. The job runtime persists state under `.codex-mimo/jobs/` with per-job `.json`, `.log`, and `.events.jsonl` files.

**MCP tools:**
- `mimo_compose` with `background: true` → returns `jobId` immediately
- `mimo_status` → job status, phase, elapsed time, recent progress
- `mimo_result` → compact final result with report paths and resume hint
- `mimo_cancel` → marks job cancelled, attempts process-tree termination
- `mimo_jobs` → list recent jobs for a workspace
- `mimo_resume_job` → creates child job from parent's MiMo session

**CLI:** `codex-mimo compose-worker --job-id <id> [--cwd <path>]` runs a background Compose job from a stored request.

**Key flow:** tools.ts creates a job record → spawns detached worker via job-process.ts → worker runs streaming MiMo CLI → runtime appends events and infers phase → on completion, writes Compose report and updates job with report paths.

## Policy

Default policy is conservative: writes outside workspace denied, secret files (.env, keys) denied, destructive commands (rm, git push, git reset) denied. Override via `codex-mimo.config.json` in project root. See `doc/policy-guide.md`.

CI mode (`--ci` flag or `ci.enabled: true` in config) converts all "ask" decisions to "deny".

## Testing

- Tests live in `test/unit/`, use vitest with `describe`/`it`/`expect`/`vi`.
- Imports from source use `.js` extensions: `import { foo } from "../../src/core/policy.js"`
- ACP client tests mock the write function and inject responses via `client.onData()`.
- No integration tests yet — the bridge requires MiMoCode CLI installed and authenticated.
- Test subdirectories mirror source structure: `acp/`, `compose/`, `core/`, `cross-cutting/`, `mcp-tools/`
- Fixtures live in `test/fixtures/` with `acp/` and `mimo-run/` subdirectories

## Plugin Structure

- `.codex-plugin/plugin.json` — Codex plugin manifest
- `.mcp.json` — MCP server config (stdio, points to `dist/codex/mcp-server.js`)
- `skills/mimocode/SKILL.md` — skill doc for when/how Codex should call MiMoCode
- `templates/` — MiMoCode project config templates

## Docs

- `doc/policy-guide.md` — policy rules and customization
- `doc/acp-message-flow.md` — ACP protocol lifecycle
- `doc/operations-guide.md` — enable/disable/rollback/troubleshooting
- `doc/compose-workflows.md` — compose workflow documentation
- `doc/codex-mimo-acp-integration-plan.md` — full implementation plan (authoritative)
