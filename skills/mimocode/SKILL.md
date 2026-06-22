---
name: mimocode
description: Use MiMoCode as a specialist coding agent for planning, implementation, review, CI repair, session resume, and Compose workflows.
---

# MiMoCode Integration Skill

Use MiMoCode as a specialist coding agent when tasks benefit from deep codebase exploration, focused implementation, independent review, or context-light delegation from the Codex main thread.

## Goal of This Bridge

Use this plugin to keep Codex focused on management, collaboration, task dispatch, and acceptance review while MiMoCode performs codebase-heavy implementation work.

Codex should avoid pulling large source files, full diffs, raw event streams, or long command logs into the main thread unless they are needed for final review. Prefer MiMoCode reports and compact tool results as the handoff boundary.

## When to Use MiMoCode

Use MiMoCode when:
- The task requires exploring a large codebase to understand patterns before implementing
- You need a second opinion on code changes (review)
- The implementation is well-scoped and can be delegated for focused execution
- CI is failing and you need help diagnosing/fixing from a log file
- The user wants Codex to conserve context by acting as planner, dispatcher, and reviewer
- A long-running feature can be split into small implementation tasks with clear verification

Do NOT use MiMoCode when:
- The task is trivial (single file, obvious change)
- You are still exploring requirements (use your own analysis first)
- The task requires interactive back-and-forth with the user
- Codex must inspect a small, specific file directly to answer a question

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
  "workflow": "brainstorm|dev|fix|fix-ci|plan|execute-plan|review|parallel|worktree|merge|new-skill",
  "task": "<task description>",
  "file": "<optional attached file>",
  "verification": ["<optional verification commands>"],
  "dryRun": false,
  "timeoutMs": 110000
}
Output: { "status": "passed|failed|needs_review", "changedFiles": [...], "reportPaths": {...} }
```

The MCP response is intentionally compact. Full JSON events, Markdown report, and event logs are persisted under `.codex-mimo/` and linked from `reportPaths`.

**Supported workflows:**
- `brainstorm` - Clarify fuzzy requirements (compose:brainstorm)
- `dev` - Feature development (brainstorm -> plan -> tdd -> verify -> review)
- `fix` - Bug fixing (debug -> tdd -> verify -> feedback)
- `fix-ci` - CI failure repair (debug -> tdd -> verify -> review)
- `plan` - Write implementation plan from an already clear requirement (compose:plan only)
- `execute-plan` - Execute an existing plan (execute -> tdd -> verify -> review)
- `review` - Review current diff (review -> feedback)
- `parallel` - Parallel exploration (parallel -> subagent -> verify)
- `worktree` - Isolate work in a git worktree (compose:worktree)
- `merge` - Finish or merge a development branch (compose:merge)
- `new-skill` - Create or update a Compose skill (compose:new-skill)

**Compose Skill Library (13 official skills):**
- Testing: `compose:tdd`
- Debugging: `compose:debug`, `compose:verify`
- Collaboration: `compose:brainstorm`, `compose:plan`, `compose:execute`, `compose:parallel`, `compose:review`, `compose:feedback`, `compose:worktree`, `compose:merge`, `compose:subagent`
- Meta-development: `compose:new-skill`

**When to use which workflow:**
- Use `brainstorm` when requirements are still unclear and need clarification.
- Use `plan` only when the task/requirement is already clear and you need an implementation plan.
- Use `execute-plan` when an approved plan file exists.
- Use `new-skill` only for Compose skill authoring.
- Use `worktree` and `merge` only for explicit git workflow tasks.

**Note:** Reports are written to `.codex-mimo/reports/` and `.codex-mimo/events/`.

## Codex Desktop Usage

### Context-Light Delegation Loop

Use this loop for software projects where Codex owns the overall plan and MiMoCode owns code-heavy execution:

1. **Codex defines the slice:** Convert the user request into a small task, expected touched areas, and verification commands.
2. **Plan when needed:** Use `mimo_plan` or `mimo_compose` with `workflow: "plan"` for read-only implementation planning.
3. **Delegate execution:** Use `mimo_compose` for most feature/fix work. Use `mimo_implement` only for a narrow, already-planned change.
4. **Read compact result first:** Check `status`, `changedFiles`, `verification`, `eventSummary`, `reviewText`, and `reportPaths`.
5. **Inspect only what matters:** Open the Markdown report or diff path when the compact result shows failures, changed files, or residual risks.
6. **Verify independently:** Run the narrowest meaningful tests or typecheck before telling the user the work is complete.
7. **Review before closing:** Use `mimo_review` for complex or risky diffs, then summarize findings to the user.

### Tool Selection

- Use `mimo_compose` with `workflow: "dev"` for feature slices.
- Use `mimo_compose` with `workflow: "fix"` for bug fixes.
- Use `mimo_compose` with `workflow: "fix-ci"` and `file` for CI logs.
- Use `mimo_compose` with `workflow: "execute-plan"` and `file` for an approved plan document.
- Use `mimo_compose` with `workflow: "review"` or `mimo_review` for acceptance review.
- Use `mimo_plan` when Codex only needs a plan and no file edits.
- Use `mimo_resume` only when continuing a known MiMoCode session.

### Context Budget Rules

- Do not paste full `.codex-mimo/events/*.jsonl` into Codex unless debugging the bridge itself.
- Do not ask MiMoCode to return full diffs in chat; use `diffPath` and Markdown report files.
- Keep each delegated task small enough that the compact result is actionable without reading the full event log.
- Prefer explicit verification commands in `mimo_compose.verification` so the returned evidence is short and decisive.
- For long or tool-time-limited runs, set `mimo_compose.timeoutMs` lower than the caller timeout so `codex-mimo` can stop MiMoCode and write a failure report instead of leaving a stray child process.
- If `status` is `needs_review`, Codex must inspect the report and relevant diff before accepting the work.

## Recommended Workflow

1. **Plan first:** Call `mimo_plan` or `mimo_compose` with `workflow: "plan"` when implementation is not yet scoped.
2. **Implement:** Prefer `mimo_compose` for workflow-driven changes; use `mimo_implement` with `allowWrite: true` for narrow tasks.
3. **Verify:** Always inspect changed files and run focused verification after implementation.
4. **Review:** Call `mimo_review` or `mimo_compose` with `workflow: "review"` for complex changes.
5. **Summarize:** Report only the task result, changed files, verification evidence, and remaining risks to the user.

## Safety

- MiMoCode respects workspace boundaries by default
- The bridge denies writes outside the project root
- Secret files (.env, keys) are blocked from read access
- Destructive commands (rm, git push, git reset) are denied
