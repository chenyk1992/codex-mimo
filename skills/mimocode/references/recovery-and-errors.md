# Recovery and Errors

Read this reference only when a job needs input, stalls, times out, or fails.

## Resume

`mimo_resume` creates a child job from `needs_input`, `blocked`, `stalled`, eligible `timeout`, or resumable failures: `build_failed`, `tests_failed`, `diff_check_failed`, `delivery_contract_missing`, and `slice_failed`.

Send only the missing or changed information. For ordinary `needs_input` or `blocked`, `task` is required. For `acceptance_config_missing`, a complete `acceptance` override is sufficient even when preflight created no session. Resume may override acceptance field-by-field and replace inherited `allowedPaths`; the merged scopes are validated again. For checkpoint-backed stalls, timeouts, and resumable failures, `task` is optional. Do not repeat the original objective or complete logs.

`acceptance_config_missing` pauses as `needs_input`; resume with the missing build/test disposition. Acceptance stages fail fast in build → test → diffCheck order. Compact results expose the failed stage, failed command/tests, and a short suggestion.

Slice-chain resume continues the attention slice and skips completed slices. `slice_plan_invalid` is not resumable; relaunch with a corrected objective or `batchMode`.

## Scope and Artifacts

Write jobs with `allowedPaths` block out-of-scope `write` and `edit` operations and run a mandatory post-run audit. `acceptance.artifactPaths` may declare bounded, non-overlapping build/test outputs; they do not widen source-edit scope and are not automatically deleted.

- `write_scope_violation`: narrow or correct `allowedPaths`, or declare expected bounded artifact paths, then relaunch.
- `acceptance_command_unavailable`: provide the repository wrapper path or install the command. Maven and Gradle commands prefer repository wrappers.

## Session Integrity

Before the first model step, the bridge verifies prompt identity. `prompt_identity_mismatch` is not resumable.

The first JSONL `sessionID` binds job completion. Child-session callbacks are ignored:

- `callback_session_mismatch`: inspect targeted callback/event diagnostics, then restart.
- `event_session_mismatch`: restart.

When multiple failures coexist, compact `mimo_result` keeps up to three causes. Use `standard` or `full` only when the complete list is necessary.
