# Compose Workflows

Read this reference when selecting `mimo_compose` or diagnosing a slice chain.

## Selection

- `brainstorm`: clarify requirements.
- `plan`: return a read-only plan.
- `dev`: implement a feature with TDD and ordered acceptance.
- `fix`: diagnose and repair a bug.
- `fix-ci`: repair failures from a supplied log file.
- `execute-plan`: execute an approved plan file.
- `review`: review the current diff.
- `parallel`: parallel exploration.
- `worktree`: explicit isolated-worktree work.
- `merge`: explicit integration work.
- `new-skill`: author or update a Compose skill.

`brainstorm`, `plan`, `dev`, `fix`, `parallel`, `worktree`, `merge`, and `new-skill` require `task`. `fix-ci` and `execute-plan` require `file`; `review` requires neither.

The `plan` workflow must return its plan in the final response and must not write project files. The bridge saves the full plan to `.codex-mimo/reports/<jobId>.plan.md`. Writing a plan file causes `read_only_violation`; no readable final result causes `result_missing`.

## Acceptance

Write workflows use `acceptance.build`, `acceptance.test`, `acceptance.diffCheck`, and optional bounded `acceptance.artifactPaths`. `dev`, `execute-plan`, and `implement` cannot complete without acceptance. Legacy `verification[]` maps to the test stage only.

## Batch and Slice Chains

- `auto`: default bounded planning.
- `single`: one narrow deliverable; requires bounded `allowedPaths`.
- `sliced`: requires at least two slices.

The bridge persists `.codex-mimo/reports/<rootJobId>.slices.json` and `.codex-mimo/jobs/<chainId>.chain.json`, then runs one slice at a time. Slice children omit notification targets; only the root job notifies and summarizes.

Planning failure ends the root with `slice_plan_invalid` and requires a new launch. A failed slice ends the root with resumable `slice_failed`. Resuming the root or attention slice continues the current slice and never relaunches completed slices.
