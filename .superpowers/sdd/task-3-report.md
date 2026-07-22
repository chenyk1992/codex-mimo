# Task 3 report: target-aware Codex launch preflight

## Scope

Replaced the launcher’s command-only Codex notification preflight with
`prepareCodexConnection({ env, threadId })` before creating any job record.
The target is the resolved explicit target or the frozen inherited resume
target; it is never taken from an ambient environment value after resolution.

## Implementation

- `src/core/job-launcher.ts`
  - uses `prepareCodexConnection` through a `prepareCodex` dependency;
  - rejects failed CLI/App Server/target preflights before persistence;
  - supplies safe recovery instructions for incompatible App Server protocol,
    missing target, and forbidden target errors, while retaining existing safe
    CLI recovery guidance;
  - best-effort closes the successful short-lived preflight connection before
    persistence. Delivery remains unchanged and reconnects later.
- `test/unit/core/job-launcher.test.ts`
  - asserts target-aware ordering: resolve -> prepare with `threadId` ->
    persist -> supervisor;
  - verifies no `.codex-mimo` artifacts, job creation, or supervisor launch on
    every failed preflight, including incompatible and inaccessible targets;
  - retains webhook/no-notify behavior, explicit `threadId` enforcement, and
    the queued receipt contract.
- `test/unit/mcp-tools/mimo-resume.test.ts`
  - verifies inherited frozen targets are preflighted with their original
    `threadId`, not a drifted ambient value;
  - snapshots all existing runtime artifact paths and proves an inaccessible
    inherited target creates no child job, outbox record, report, event, or
    signal artifact.
- `test/integration/unified-background-jobs.test.ts`
  - updates the launch dependency test double to the new target-aware API.

## RED evidence

Before changing production code, the updated launcher unit test failed with 10
failures. The launcher ignored `prepareCodex`, ran the old command-only probe,
and consequently returned `codex_cli_not_found`; the ordering and recovery
expectations therefore failed for target-aware cases.

The unchanged resume test then failed with 3 failures for the same reason:
inherited Codex targets were still trying the command-only default preflight.

## GREEN evidence

- `npm.cmd test -- job-launcher.test.ts` — 18 passed.
- `npm.cmd test -- mimo-resume.test.ts` — 15 passed.
- `npm.cmd test -- job-launcher.test.ts mimo-resume.test.ts codex-connection.test.ts` — 39 passed.
- `npm.cmd test -- unified-background-jobs.test.ts` — 23 passed.
- `npm.cmd test` — 1,017 passed; 6 prerequisite-gated smoke tests skipped.
- `npm.cmd run lint` — passed.
- `npm.cmd run build` — passed.
- `npm.cmd run validate:plugin` — passed.
- `git diff --check` — passed.

The test suite emits pre-existing Windows line-ending warnings for its fixture
workspaces; no verification command failed because of them.
