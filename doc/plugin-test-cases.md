# Codex MiMoCode Plugin Test Cases

Use these cases inside Codex after installing the plugin. The expected behavior is that Codex calls the MCP tools when they are available, and falls back to the local CLI only when the MCP server is unavailable.

## Test 1: Healthcheck

Input:

```text
Check whether MiMoCode is available in this project.
```

Expected behavior: Codex calls `mimo_healthcheck` and returns the version or a clear setup error.

## Test 2: Plan

Input:

```text
Use MiMoCode to plan how to add unit tests to this project.
```

Expected behavior: Codex calls `mimo_plan` or `mimo_compose` with `workflow: "plan"` and reports that no implementation changes were accepted without review.

## Test 3: Review

Input:

```text
Review the current diff for bugs and regressions.
```

Expected behavior: Codex calls `mimo_review` or `mimo_compose` with `workflow: "review"` and returns findings first.

## Test 4: Compose Dev

Input:

```text
Use compose dev to create a minimal CHANGELOG.md update.
```

Expected behavior: Codex calls `mimo_compose` with `workflow: "dev"`, then independently inspects the diff and runs focused verification.

## Test 5: Compose Plan With Timeout

Input:

```text
Use compose plan with a 110000 ms timeout to analyze how to add integration tests.
```

Expected behavior: Codex calls `mimo_compose` with `workflow: "plan"` and `timeoutMs: 110000` so the bridge can stop MiMoCode before an outer tool timeout.

## Test 6: Attached File Argument Order

Input:

```text
Use compose execute-plan with docs/example-plan.md as the attached file.
```

Expected behavior: The generated MiMoCode argv places the prompt before `--file docs/example-plan.md`, preventing the `--file` array parser from treating `Objective:` as a path.

## Test 7: Dependency Failure

Input:

```text
Run codex-mimo healthcheck from the installed plugin cache.
```

Expected behavior: If runtime dependencies are missing, the error clearly points to installing dependencies or using a bundled plugin build. `ERR_MODULE_NOT_FOUND` should not be treated as a MiMoCode auth failure.

## Test Record

| Test | Input summary | Result | Notes |
| --- | --- | --- | --- |
| 1 | Healthcheck | TODO | |
| 2 | Plan | TODO | |
| 3 | Review | TODO | |
| 4 | Compose dev | TODO | |
| 5 | Compose plan timeout | TODO | |
| 6 | Attached file order | TODO | |
| 7 | Dependency failure | TODO | |
