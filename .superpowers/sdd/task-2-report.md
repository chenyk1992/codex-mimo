# Task 2 report: target-aware Codex App Server probe

## Delivered

- Added `src/notify/codex-connection.ts` to probe each discovered candidate with
  `--version`, App Server `initialize`, and `thread/resume(threadId)`.
- A compatible idle or busy task returns a retained, non-enumerable prepared
  client. Rejected clients are closed best-effort.
- Implicit candidates fall through executable, unavailable, and incompatible
  protocol failures. Missing and forbidden tasks stop immediately; configured
  candidates are authoritative for every failure.
- The public probe surface contains only `ok`, `source`, `version`, and safe
  `errorCode` fields. The client is intentionally non-enumerable so serializing
  a preparation result cannot reveal process details.
- Exported the existing candidate-discovery and failure-classification helpers
  from `codex-command.ts` so the connection layer reuses Task 1's ordering and
  safe command classification without duplicating it.

`codex-app-server.ts` already accepted an injected `CodexCommandSelection` and
used it to launch the App Server, so no additional change there was needed for
this layer.

## TDD evidence

1. Added the connection tests before creating the module. The focused test run
   failed because `src/notify/codex-connection.js` did not exist.
2. Added the minimal candidate loop, handshake, classification, and cleanup
   implementation. The six connection tests passed.
3. A compiler check exposed that the command-only probe type cannot represent
   task compatibility codes such as `codex_thread_missing`. The root cause was
   a type-boundary mismatch, so the connection layer now has its own safe probe
   type using the established notification error-code allowlist.
4. Added a privacy regression with a mock client carrying a private command.
   It failed while `client` was enumerable in the result, then passed after the
   prepared client was made non-enumerable.

## Verification

- `npm.cmd test -- codex-connection.test.ts` — 6 passed.
- `npm.cmd test -- codex-connection.test.ts codex-command.test.ts codex-app-server.test.ts` — 83 passed.
- `npm.cmd run lint` — passed.
- `npm.cmd run build` — passed.
- `npm.cmd test` — 1,013 passed; 6 opt-in smoke tests skipped.
- `git diff --check` — passed.
