# Codex MiMoCode Bridge

A bridge that lets Codex invoke MiMoCode as a specialist coding agent for planning, implementation, and review.

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
```

## CLI Usage (MVP)

```bash
codex-mimo plan "Add login rate limiting"
codex-mimo implement "Fix failing user-session test"
codex-mimo review
codex-mimo healthcheck
```

## Compose Workflow Launcher

Use `codex-mimo compose` when you want MiMoCode to run a skill-driven workflow:

```bash
codex-mimo compose --workflow dev "Implement login throttling"
codex-mimo compose --workflow fix-ci --file ci.log
codex-mimo compose --workflow execute-plan --file doc/codex-mimo-acp-integration-plan.md
codex-mimo compose --workflow review --since HEAD
codex-mimo compose --workflow plan --timeout-ms 110000 "Create a validation plan"
```

Reports are written to:

```text
.codex-mimo/reports/
.codex-mimo/events/
```

Each report includes MiMoCode JSON events, changed files, diff stat, verification command results, and review text.

When a caller has its own timeout, pass `--timeout-ms` lower than the outer timeout so `codex-mimo` can stop MiMoCode and write a report instead of leaving a child process running.

## Codex Plugin Installation

The project is packaged as a Codex plugin. To install:

1. Build the project: `npm run build`
2. The plugin is at the project root with:
   - `.codex-plugin/plugin.json` - plugin manifest
   - `.mcp.json` - MCP server configuration
   - `skills/mimocode/SKILL.md` - skill describing when/how to use MiMoCode

The MCP server exposes these tools to Codex:

| Tool | Description |
|------|-------------|
| `mimo_healthcheck` | Check MiMoCode installation and auth state |
| `mimo_plan` | Create implementation plans without editing files |
| `mimo_implement` | Implement code changes with surgical precision |
| `mimo_review` | Review current diff for bugs and regressions |
| `mimo_fix_ci` | Fix CI failures using a log file |
| `mimo_resume` | Resume a previous MiMoCode session |
| `mimo_compose` | Run a MiMoCode Compose workflow and return a structured report |

If the installed plugin cache fails with `ERR_MODULE_NOT_FOUND`, the cache is missing runtime dependencies. Reinstall dependencies in the plugin root or use a bundled plugin build; `dist/` alone is not enough for the current NodeNext build.

## Safety Model

- Writes outside workspace: **denied**
- Secret file reads (.env, keys): **denied**
- Destructive commands (rm, git push, git reset): **denied**
- Test/lint/typecheck commands: **allowed**
- Package install commands: **ask**

See `doc/policy-guide.md` for the full policy specification.

## Architecture

```
Codex -> MCP Server -> CLI Commands -> mimo run/ACP -> MiMoCode
                                    ^
                              Policy Layer
                              Audit Log
```

## Project Structure

```
src/
  cli/          CLI entry point and commands
  core/         Policy, paths, audit, terminal management
  mimo/         ACP client, bridge, process supervisor
  codex/        MCP server and tool definitions
templates/      MiMoCode configuration templates
skills/         Codex skill definitions
doc/            Documentation
```

## Configuration

Copy `templates/mimocode.jsonc` to your project root and customize as needed.
