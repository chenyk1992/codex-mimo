# Task 6 report: installed-plugin-path acceptance preparation

## Scope

- Updated the gated local Codex notification smoke without running it against a
  Codex task.
- Added deterministic Windows integration coverage for the Desktop-local
  executable discovery, preflight, notification delivery, and one-turn callback
  lifecycle.
- Did not change `.codex-plugin/plugin.json`, refresh/install the plugin, or
  modify unrelated untracked plans.

## Coverage added

`test/smoke/local-codex-notification.test.ts` now:

- requires both Windows and `RUN_LOCAL_CODEX_NOTIFY_SMOKE=1`;
- removes `CODEX_MIMO_CODEX_BIN` from the MCP process environment before the
  CLI probe and server launch;
- requires the probe to select the `desktop-local` source;
- retains its queued-receipt, exactly-one `mimo_result`, no-`mimo_wait`, and
  exactly-one `turn/start` assertions.

`test/integration/unified-background-jobs.test.ts` now creates a temporary
`LOCALAPPDATA\\OpenAI\\Codex\\bin\\current\\codex.exe` layout with no override or
PATH executable. It verifies automatic Desktop-local selection for both launch
preflight and final delivery, a queued implement receipt, a completed job and
delivered outbox entry, and exactly one callback `turn/start` (with one
initialize/resume for preflight and one for delivery).

## Verification

- `npm test -- unified-background-jobs.test.ts` — 24 passed.
- `npm test -- local-codex-notification.test.ts` — safely skipped (opt-in is
  unset; no real Codex task contacted).
- `npm run lint` — passed.
- `npm run build` — passed.
- `npm test` — 1,021 passed, 6 gated tests skipped.
- `npm run validate:plugin` — passed.

The installed-plugin cache refresh and the real Desktop smoke are intentionally
left to the controller's host acceptance step.
