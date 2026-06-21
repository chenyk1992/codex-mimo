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
  cli/main.ts         CLI entrypoint (bin: codex-mimo)
  cli/commands.ts     plan / implement / review wrappers around mimo run
  codex/mcp-server.ts MCP server entrypoint (stdio, run via node dist/codex/mcp-server.js)
  codex/tools.ts      MCP tool handlers (mimo_plan, mimo_implement, mimo_review, ...)
  core/policy.ts      file/command policy engine (minimatch globs)
  core/config.ts      loads codex-mimo.config.json, merges with defaults
  core/audit.ts       JSONL audit logger with rotation
  core/sessions.ts    session persistence (.codex-mimo/sessions.json)
  core/terminal.ts    subprocess manager for ACP terminal requests
  mimo/acp-client.ts  JSON-RPC client (line-framed, request/response correlation)
  mimo/acp-bridge.ts  full ACP lifecycle: init → session/new → prompt, policy enforcement
  mimo/run-json.ts    builds args for `mimo run --format json`
```

Two integration paths:
- **MVP**: CLI calls `mimo run --format json` via execa
- **ACP**: AcpBridge launches `mimo acp`, speaks JSON-RPC over stdio

## Key Quirks

- **ESM-only**: `"type": "module"` in package.json. All imports must use `.js` extensions even for `.ts` source files (NodeNext resolution).
- **execa v9**: Use `type Subprocess` (not `ExecaChildProcess` which doesn't exist in v9).
- **stdin: "ignore"**: CLI commands that spawn `mimo run` MUST set `stdin: "ignore"` in execa options. Without this, mimo waits for stdin and the process never exits.
- **mimo run --format json** outputs JSONL (newline-delimited JSON), not a single JSON object.
- **MCP server self-starts**: `mcp-server.ts` calls `startMcpServer()` at module top level — it's both a library export and a runnable entrypoint.

## Policy

Default policy is conservative: writes outside workspace denied, secret files (.env, keys) denied, destructive commands (rm, git push, git reset) denied. Override via `codex-mimo.config.json` in project root. See `doc/policy-guide.md`.

CI mode (`--ci` flag or `ci.enabled: true` in config) converts all "ask" decisions to "deny".

## Testing

- Tests live in `test/unit/`, use vitest with `describe`/`it`/`expect`/`vi`.
- Imports from source use `.js` extensions: `import { foo } from "../../src/core/policy.js"`
- ACP client tests mock the write function and inject responses via `client.onData()`.
- No integration tests yet — the bridge requires MiMoCode CLI installed and authenticated.

## Plugin Structure

- `.codex-plugin/plugin.json` — Codex plugin manifest
- `.mcp.json` — MCP server config (stdio, points to `dist/codex/mcp-server.js`)
- `skills/mimocode/SKILL.md` — skill doc for when/how Codex should call MiMoCode
- `templates/` — MiMoCode project config templates

## Docs

- `doc/policy-guide.md` — policy rules and customization
- `doc/acp-message-flow.md` — ACP protocol lifecycle
- `doc/operations-guide.md` — enable/disable/rollback/troubleshooting
- `doc/codex-mimo-acp-integration-plan.md` — full implementation plan (authoritative)
