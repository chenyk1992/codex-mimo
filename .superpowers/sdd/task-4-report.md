# Task 4 report: durable target-aware Codex delivery

## Delivered

- `src/notify/dispatcher.ts` now prepares each Codex outbox delivery with
  `prepareCodexConnection({ threadId, env, signal })`. Command discovery is
  therefore repeated in the notification worker's environment and is never
  stored in the job or outbox target.
- `src/notify/codex-adapter.ts` consumes the prepared private client and thread
  state directly. It no longer initializes or resumes the task a second time;
  busy prepared tasks retry without `turn/start`, idle tasks receive exactly one
  callback turn, and every prepared client is closed best-effort in `finally`.
- Focused tests prove the worker environment is supplied to preparation, the
  durable target remains only `{ type: "codex", threadId }`, and adapter idle,
  busy, missing, preparation-error, and cleanup paths have the expected result.
- `test/integration/unified-background-jobs.test.ts` updates its old
  `createCodexClient` fixture seam to invoke the real connection preparer with
  fake candidate/client dependencies, so existing RPC integration tests retain
  their initialize/resume/turn coverage.

## RED evidence

Before changing production code:

- `npm test -- test/unit/notify/codex-adapter.test.ts test/unit/notify/dispatcher.test.ts`
  reported 9 failures out of 44 tests. The adapter attempted to initialize and
  resume the prepared object, while the dispatcher never called `prepareCodex`.

The first full-suite run after replacing the dispatcher seam identified four
stale integration fixtures using `createCodexClient`; they were updated to
exercise `prepareCodexConnection` rather than restoring the obsolete bare-client
path.

## GREEN evidence

- `npm test -- test/unit/notify/codex-adapter.test.ts test/unit/notify/dispatcher.test.ts`
  — 44 passed.
- `npm test -- test/integration/unified-background-jobs.test.ts` — 23 passed.
- `npm test` — 1,015 passed; 6 prerequisite-gated smoke tests skipped.
- `npm run lint` — passed.
- `npm run build` — passed.
- `npm run validate:plugin` — passed.
- `git diff --check` — passed.

The test suite emitted existing Windows line-ending warnings for temporary test
workspaces; no verification command failed because of them.
