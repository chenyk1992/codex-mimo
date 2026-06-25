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

## Available Tools (12)

### `mimo_healthcheck`

Check MiMoCode installation and auth state.

```
Input: { "cwd": "<project-root>" }
Output: { "ok": true, "version": "...", "cwd": "..." }
```

### `mimo_plan`

Create an implementation plan using MiMoCode planning agent.

```
Input: {
  "cwd": "<project-root>",
  "task": "<task description>",
  "agent": "plan",
  "model": "<optional model override>",
  "timeoutMs": 1800000
}
Output: { "summary": "...", "sessionId": "...", "changedFiles": [], "verification": [] }
```

### `mimo_implement`

Implement code changes using MiMoCode implementation agent.

```
Input: {
  "cwd": "<project-root>",
  "task": "<task description>",
  "allowWrite": true,
  "allowInstall": false,
  "timeoutMs": 1800000
}
Output: { "summary": "...", "sessionId": "...", "changedFiles": [...], "commands": [] }
```

**Important:** Always set `allowWrite: true` when you want MiMoCode to actually modify files.

After `mimo_implement`, you MUST:
1. Run `git diff` to inspect changes
2. Run verification (tests, lint, typecheck)
3. Review the output for correctness before reporting to the user

### `mimo_review`

Review the current diff using MiMoCode review agent.

```
Input: {
  "cwd": "<project-root>",
  "base": "HEAD",
  "timeoutMs": 1800000
}
Output: { "summary": "...", "sessionId": "...", "findings": [...] }
```

### `mimo_fix_ci`

Fix CI failures using MiMoCode with a CI log file.

```
Input: {
  "cwd": "<project-root>",
  "file": "./ci.log",
  "task": "<optional context>",
  "timeoutMs": 1800000
}
Output: { "summary": "...", "sessionId": "...", "changedFiles": [...], "commands": [] }
```

### `mimo_resume`

Resume a previous MiMoCode session to continue work.

```
Input: {
  "cwd": "<project-root>",
  "session": "<session-id>",
  "task": "continue the task",
  "timeoutMs": 1800000
}
Output: { "summary": "...", "sessionId": "...", "changedFiles": [...], "commands": [] }
```

### `mimo_status`

Show active or recent MiMoCode job status.

```
Input: { "cwd": "<project-root>", "jobId": "<optional-job-id>" }
Output: { "jobId": "...", "status": "running|completed|failed|cancelled", "phase": "...", "elapsed": "..." }
```

### `mimo_result`

Return the compact final result for a finished MiMoCode job.

```
Input: { "cwd": "<project-root>", "jobId": "<optional-job-id>" }
Output: { "status": "...", "changedFiles": [...], "reportPaths": {...}, "directResumeHint": "..." }
```

### `mimo_cancel`

Cancel a running background job.

```
Input: { "cwd": "<project-root>", "jobId": "<job-id>" }
Output: { "cancelled": true }
```

### `mimo_jobs`

List recent jobs for a workspace.

```
Input: { "cwd": "<project-root>", "all": false }
Output: { "jobs": [{ "jobId": "...", "status": "...", "workflow": "..." }] }
```

### `mimo_resume_job`

Create a child job from a parent job's session.

```
Input: {
  "cwd": "<project-root>",
  "jobId": "<parent-job-id>",
  "task": "<continuation task>",
  "background": false
}
Output: { "jobId": "<new-job-id>" }
```

### `mimo_compose`

Run a MiMoCode Compose workflow and return a structured report.

```
Input: {
  "cwd": "<project-root>",
  "workflow": "brainstorm|dev|fix|fix-ci|plan|execute-plan|review|parallel|worktree|merge|new-skill",
  "task": "<task description>",
  "file": "<optional attached file>",
  "since": "<optional git ref>",
  "model": "<optional model override>",
  "attach": "<optional MiMoCode server URL>",
  "session": "<optional session ID>",
  "fork": false,
  "continue": false,
  "verification": ["<optional verification commands>"],
  "dryRun": false,
  "reportDir": "<optional report directory>",
  "timeoutMs": 1800000,
  "background": false,
  "wait": false
}
Output: { "status": "passed|failed|needs_review|timeout", "changedFiles": [...], "reportPaths": {...} }
```

**Background jobs:** Set `background: true` for long-running tasks. Returns `jobId` immediately. Use `mimo_status`, `mimo_result`, `mimo_cancel` to manage.

**Verification:** Commands are auto-detected from project type (`python -m pytest` for Python, `cargo test` for Rust, `go test ./...` for Go, `npm test` for Node). Override with `verification` array.

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
- For tasks > 5 minutes, use `background: true` and poll with `mimo_status` / `mimo_result`.
- Default `timeoutMs` is 30 minutes (1,800,000ms). Increase for very large tasks.

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
