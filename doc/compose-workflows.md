# Compose Workflows

`codex-mimo compose` starts MiMoCode in Compose mode and asks it to use named skills for repeatable workflows.

## Workflows

| Name | Skill chain | Use |
| --- | --- | --- |
| `dev` | `compose:brainstorm -> compose:plan -> compose:tdd -> compose:verify -> compose:review` | Feature work |
| `fix` | `compose:debug -> compose:tdd -> compose:verify -> compose:feedback` | Bug fixes |
| `fix-ci` | `compose:debug -> compose:tdd -> compose:verify -> compose:review` | CI repair |
| `plan` | `compose:brainstorm -> compose:plan` | Read-only planning |
| `execute-plan` | `compose:execute -> compose:tdd -> compose:verify -> compose:review` | Execute approved plans |
| `review` | `compose:review -> compose:feedback` | Diff review |
| `parallel` | `compose:parallel -> compose:subagent -> compose:verify` | Independent subtask exploration |

## Report Contract

Every run writes a Markdown report, JSON report, and JSONL event log.

## Safety

The launcher never passes `--dangerously-skip-permissions`. It does not commit, push, reset, or delete files.
