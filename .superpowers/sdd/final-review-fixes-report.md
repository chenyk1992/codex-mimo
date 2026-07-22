# Final Review Fixes Report

Date: 2026-07-22

Branch: `master`

Scope: four final-review findings for installed-plugin smoke coverage, deterministic Desktop discovery, resilient Desktop candidate scanning, and delivery-attempt cancellation.

## Outcome

All four findings were fixed with focused regression coverage. Production Codex command precedence is unchanged: an explicit `CODEX_MIMO_CODEX_BIN` remains authoritative, PATH candidates remain ahead of Desktop-local candidates, and Desktop-local discovery is used only after those implicit PATH candidates are exhausted or absent.

The installed plugin cache was not refreshed or modified.

## Finding 1 — run the real smoke from the installed plugin package

### Root cause

`test/smoke/local-codex-notification.test.ts` derived its MCP root from the source test location (`../..`). A missing or stale installed plugin cache therefore had no effect on the smoke outcome because the test always started the checkout's `.mcp.json` and `dist/codex/mcp-server.js`.

### RED

Command:

```text
npm test -- local-codex-notification-smoke.test.ts
```

Observed before the smoke helper implementation:

```text
Test Files  1 failed (1)
Tests       5 failed (5)
```

The failures showed that the existing behavior did not require an installed root, accepted the checkout as the root, accepted a stale manifest version, returned the checkout instead of the installed package, and retained Codex-bearing PATH directories.

### GREEN

Added the smoke-only `CODEX_MIMO_INSTALLED_PLUGIN_ROOT` route. The resolver now:

- requires an explicit absolute installed package path;
- resolves the real source and installed roots and rejects equality;
- requires `.mcp.json` and a valid `codex-mimocode` manifest;
- rejects an installed manifest version that differs from the checkout;
- returns the installed root, from which the smoke reads `.mcp.json`, resolves `cwd`, and verifies built JavaScript entrypoints.

Command after implementation:

```text
npm test -- local-codex-notification-smoke.test.ts
```

Observed:

```text
Test Files  1 passed (1)
Tests       5 passed (5)
```

The normal smoke command without `RUN_LOCAL_CODEX_NOTIFY_SMOKE=1` was also run and remained safely gated:

```text
Test Files  1 skipped (1)
Tests       1 skipped (1)
```

## Finding 2 — isolate PATH in the Desktop-local smoke

### Root cause

The smoke removed `CODEX_MIMO_CODEX_BIN` but retained the ambient PATH. Because production intentionally gives PATH candidates precedence over Desktop-local candidates, a machine with any PATH `codex` could make the smoke exercise the wrong discovery branch.

### RED

The same initial five-test RED run included a regression that supplied three PATH directories (two exposing `codex.exe`/`codex.CMD`, one clean). The helper retained all three and also retained the configured override.

### GREEN

The smoke environment now removes `CODEX_MIMO_CODEX_BIN`, removes all case variants of the PATH key, filters every PATH directory containing a `codex` token or PATHEXT variant, and writes back one isolated `PATH`. Non-Codex tool directories and unrelated environment values remain available to Node, Git, MiMoCode, and detached workers.

The smoke still asserts `probe.source === "desktop-local"`. No production discovery order changed.

## Finding 3 — continue after one unreadable Desktop version folder

### Root cause

The outer `try` covered the complete version-folder loop. A single `statSync(folder)` failure exited that loop, hiding all later version folders. The stable root happened to remain eligible because it was appended outside the outer `try`, but other valid version candidates did not.

### RED

Command:

```text
npm test -- codex-command.test.ts
```

Observed with an injected `EACCES` for the newer version folder:

```text
Test Files  1 failed (1)
Tests       1 failed | 29 passed (30)
```

The probe skipped directly to the stable root instead of attempting the valid older version and then the root.

### GREEN

Each version entry is now inspected inside its own `try/catch`. An inaccessible or malformed entry is skipped without ending the directory scan; remaining version folders are still sorted by modification time, followed by the stable root.

Observed after the fix:

```text
Test Files  1 passed (1)
Tests       30 passed (30)
```

## Finding 4 — cancel Codex version execution when delivery ownership is lost

### Root cause

`dispatchNextDelivery` already created and aborted a delivery-attempt signal on lease-renewal failure, and it passed that signal into `prepareCodexConnection`. App Server initialization and thread resume received it, but `readVersion` omitted it from the injected/Execa execution options. A lease loss therefore could not cancel an in-flight `codex --version` probe.

### RED

Command:

```text
npm test -- codex-connection.test.ts
```

Observed before propagation:

```text
Test Files  1 failed (1)
Tests       1 failed | 7 passed (8)
```

The injected version executor received `env`, `reject`, and `timeout`, but no `cancelSignal`.

### GREEN

Introduced the shared exported `CodexCommandExecutionOptions` and `CodexCommandExecutor` types. `prepareCodexConnection` now passes its existing attempt signal through `readVersion` as `cancelSignal`; the default executor forwards those options directly to Execa. Undefined signals remain omitted, preserving existing non-delivery behavior.

Observed after the fix:

```text
Test Files  1 passed (1)
Tests       8 passed (8)
```

## Focused verification

Command:

```text
npm test -- local-codex-notification-smoke.test.ts codex-command.test.ts codex-connection.test.ts dispatcher.test.ts --reporter=dot
```

Observed:

```text
Test Files  4 passed (4)
Tests       71 passed (71)
```

This covers the smoke configuration, command candidate order and error handling, connection preparation/cancellation, and dispatcher lease-signal wiring.

## Full verification

Fresh commands and results:

```text
npm test -- --reporter=dot
Test Files  78 passed | 3 skipped (81)
Tests       1028 passed | 6 skipped (1034)

npm run lint
exit 0

npm run build
exit 0

npm run validate:plugin
Plugin validation passed: E:\ideaProjects\codex-mimo

git diff --check
exit 0
```

The skipped tests are explicitly gated real-machine smokes. The real Codex callback smoke was not enabled because this task forbids refreshing the installed cache; its configuration contract and disabled gating path were verified locally instead.

## Files changed

- `test/smoke/local-codex-notification.test.ts`
- `test/smoke/local-codex-notification-support.ts`
- `test/unit/local-codex-notification-smoke.test.ts`
- `src/notify/codex-command.ts`
- `src/notify/codex-connection.ts`
- `test/unit/notify/codex-command.test.ts`
- `test/unit/notify/codex-connection.test.ts`
- `README.md`
- `doc/operations-guide.md`

No unrelated behavior was intentionally changed, and pre-existing untracked plan files were not staged.
