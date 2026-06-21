---
name: mimocode
description: Use MiMoCode as a specialist coding agent for planning, implementation, review, CI repair, session resume, and Compose workflows.
---

# MiMoCode Integration Skill

Use MiMoCode as a specialist coding agent when tasks benefit from deep codebase exploration, focused implementation, or independent review.

## When to Use MiMoCode

Use MiMoCode when:
- The task requires exploring a large codebase to understand patterns before implementing
- You need a second opinion on code changes (review)
- The implementation is well-scussed and can be delegated for focused execution
- CI is failing and you need help diagnosing/fixing from a log file

Do NOT use MiMoCode when:
- The task is trivial (single file, obvious change)
- You are still exploring requirements (use your own analysis first)
- The task requires interactive back-and-forth with the user

## Available Tools

### `mimo_healthcheck`

Check if MiMoCode is installed and configured before first use.

```
Input: { "cwd": "<project-root>" }
Output: { "ok": true, "version": "...", "cwd": "..." }
```

### `mimo_plan`

Create an implementation plan. MiMoCode will inspect the codebase and produce a plan without editing files.

```
Input: { "cwd": "<project-root>", "task": "<task description>" }
Output: { "summary": "...", "changedFiles": [], "verification": [] }
```

### `mimo_implement`

Delegate implementation. MiMoCode will make surgical code changes.

```
Input: { "cwd": "<project-root>", "task": "<task description>", "allowWrite": true }
Output: { "summary": "...", "changedFiles": [...], "verification": [] }
```

**Important:** Always set `allowWrite: true` when you want MiMoCode to actually modify files.

After `mimo_implement`, you MUST:
1. Run `git diff` to inspect changes
2. Run verification (tests, lint, typecheck)
3. Review the output for correctness before reporting to the user

### `mimo_review`

Review the current diff. MiMoCode will analyze changes for bugs, regressions, and missing tests.

```
Input: { "cwd": "<project-root>", "base": "HEAD" }
Output: { "findings": [...], "summary": "..." }
```

### `mimo_fix_ci`

Fix CI failures by providing a log file.

```
Input: { "cwd": "<project-root>", "file": "./ci.log", "task": "optional context" }
Output: { "summary": "...", "changedFiles": [...], "verification": [] }
```

### `mimo_resume`

Resume a previous MiMoCode session to continue work.

```
Input: { "cwd": "<project-root>", "session": "<session-id>", "task": "continue the task" }
Output: { "summary": "...", "changedFiles": [...], "verification": [] }
```

### `mimo_compose`

Run a Compose workflow for structured development tasks. Best for multi-step workflows that benefit from skill chaining.

```
Input: { 
  "cwd": "<project-root>",
  "workflow": "dev|fix|fix-ci|plan|execute-plan|review|parallel",
  "task": "<task description>",
  "file": "<optional attached file>",
  "verification": ["<optional verification commands>"],
  "dryRun": false
}
Output: { "status": "passed|failed|needs_review", "changedFiles": [...], "reportPaths": {...} }
```

**Supported workflows:**
- `dev` - Feature development (brainstorm → plan → tdd → verify → review)
- `fix` - Bug fixing (debug → tdd → verify → feedback)
- `fix-ci` - CI failure repair (debug → tdd → verify → review)
- `plan` - Planning only (brainstorm → plan)
- `execute-plan` - Execute an existing plan
- `review` - Review current diff
- `parallel` - Parallel exploration

**Note:** Reports are written to `.codex-mimo/reports/` and `.codex-mimo/events/`.

## Recommended Workflow

1. **Plan first:** Call `mimo_plan` to get a plan before implementation
2. **Implement:** Call `mimo_implement` with `allowWrite: true`
3. **Verify:** Always run `git diff` and tests after implementation
4. **Review:** Call `mimo_review` for a second opinion on complex changes

## Safety

- MiMoCode respects workspace boundaries by default
- The bridge denies writes outside the project root
- Secret files (.env, keys) are blocked from read access
- Destructive commands (rm, git push, git reset) are denied
