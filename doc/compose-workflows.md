# Compose Workflows

`codex-mimo compose` starts MiMoCode in Compose mode and asks it to use named skills for repeatable workflows.

## Workflows

| Name | Skill chain | Writes | Requires task | Use |
| --- | --- | --- | --- | --- |
| `brainstorm` | `compose:brainstorm` | no | yes | Clarify fuzzy requirements |
| `dev` | `compose:brainstorm -> compose:plan -> compose:tdd -> compose:verify -> compose:review` | yes | yes | Feature work |
| `fix` | `compose:debug -> compose:tdd -> compose:verify -> compose:feedback` | yes | yes | Bug fixes |
| `fix-ci` | `compose:debug -> compose:tdd -> compose:verify -> compose:review` | yes | no | CI repair from a log |
| `plan` | `compose:plan` | no | yes | Write implementation plan from an already clear requirement |
| `execute-plan` | `compose:execute -> compose:tdd -> compose:verify -> compose:review` | yes | no | Execute approved plans |
| `review` | `compose:review -> compose:feedback` | no | no | Diff review |
| `parallel` | `compose:parallel -> compose:subagent -> compose:verify` | yes | yes | Independent subtask exploration |
| `worktree` | `compose:worktree` | yes | yes | Isolate work in a git worktree |
| `merge` | `compose:merge` | yes | yes | Finish or merge a development branch |
| `new-skill` | `compose:new-skill` | yes | yes | Create or update a Compose skill |

## Official Skill Coverage

All 13 official MiMo Code Compose skills are covered:

**Testing:**
- `compose:tdd`

**Debugging:**
- `compose:debug`
- `compose:verify`

**Collaboration:**
- `compose:brainstorm`
- `compose:plan`
- `compose:execute`
- `compose:parallel`
- `compose:review`
- `compose:feedback`
- `compose:worktree`
- `compose:merge`
- `compose:subagent`

**Meta-development:**
- `compose:new-skill`

## Notes

The `plan` workflow intentionally uses only `compose:plan`. Use `brainstorm` before `plan` when requirements are still unclear.

## Report Contract

Every run writes a Markdown report, JSON report, and JSONL event log.

## Timeouts

Use CLI `--timeout-ms` or MCP `timeoutMs` when the caller has its own timeout. Set the bridge timeout lower than the outer timeout so `codex-mimo` can stop MiMoCode and still write a report.

```bash
codex-mimo compose --workflow plan --timeout-ms 110000 "Create a validation plan"
```

## Background Execution

Use `background: true` for long workflows such as `dev`, `fix`, `fix-ci`, `execute-plan`, and `parallel`.

The launch response includes a `jobId`. Use job tools to check progress, retrieve results, or cancel:

- `mimo_status`
- `mimo_result`
- `mimo_cancel`
- `mimo_jobs`

Reports remain the full artifact of record. Job responses stay compact so they are safe to return to Codex.

## Safety

The launcher never passes `--dangerously-skip-permissions`. It does not commit, push, reset, or delete files.
