# Codex callback turn lifecycle design

Date: 2026-07-23
Status: approved for implementation planning
Primary approach: one stdio App Server connection remains open through `turn/completed`

## Incident and problem

MiMoCode job `compose-mrwaqun4-wc1gtf` completed successfully and its notification outbox record advanced to `delivered`, but originating Codex task `019f8aa7-20dd-7c20-af98-81116b02ef2c` did not receive an automatic assistant response.

The evidence separates three states that the current implementation conflates:

1. The MiMoCode job completed at `2026-07-22T16:34:22.530Z`.
2. The Codex App Server accepted `turn/start` and the outbox was marked `delivered` at `2026-07-22T16:34:23.586Z`.
3. The callback turn started in the same second, ran for 117 ms, contained no items, and ended as `interrupted`.

`deliverCodexNotification()` currently treats resolution of `client.startTurn()` as delivery success and immediately closes the App Server client in `finally`. `StdioCodexAppServerClient.startTurn()` only waits for the `turn/start` RPC response. It does not keep the transport alive until the server emits `turn/completed`.

The App Server protocol defines `turn/start` as the beginning of a turn. A client must continue reading notifications from the active transport and use `turn/completed` as the terminal lifecycle event. Therefore the existing outbox `delivered` state means only “start request accepted,” while callers and documentation interpret it as “callback turn completed and wrote back to the task.”

## Goals

1. Keep the selected stdio App Server connection alive from initialization through the callback turn's terminal event.
2. Mark a Codex notification `delivered` only after the exact callback turn reaches `status: "completed"`.
3. Classify `interrupted`, `failed`, completion timeout, transport loss, malformed lifecycle frames, and thread-busy conditions without exposing private protocol details.
4. Preserve durable outbox leasing, retry behavior, target preflight, prompt scrubbing, and webhook behavior.
5. Prove the installed plugin causes the originating Codex task to call `mimo_result` and produce a non-empty completed callback turn.
6. Keep the implementation small: one process per Codex delivery attempt, no shared daemon and no persistent connection pool.

## Non-goals

- Replacing stdio with the experimental App Server WebSocket transport.
- Maintaining one App Server process across multiple outbox deliveries.
- Providing exactly-once callback execution; delivery remains at-least-once.
- Persisting callback prompt text, model output, raw RPC frames, stderr, executable paths, environment values, or App Server error messages.
- Redesigning job completion, MiMo `session.post`, Cursor companion hooks, or webhook delivery.
- Adding progress text from the callback turn to notification records.
- Changing the stable queued work receipt shape.

## Context and token impact

The selected approach reduces Codex context and token consumption relative to the broken/manual-recovery path, but RPC is not itself a model-token bypass.

- `initialize`, `thread/resume`, `turn/start`, lifecycle notifications, and `turn/completed` are local JSON-RPC control frames. Keeping that transport open does not add model prompt content.
- The callback prompt remains a compact identity-and-action instruction, capped at 240 characters for normal job ids. It does not embed the original MiMo prompt, JSONL, logs, reports, diffs, or model output.
- A successful automatic callback replaces the current recovery sequence in which the user starts another Codex turn, asks for status, and causes Codex to call both `mimo_status` and `mimo_result`. It also avoids polling turns while MiMo is running.
- One Codex model turn is still required to call `mimo_result`, inspect the returned result, and write the user-facing answer. `mimo_result.output` becomes tool context in that turn and can be large for detailed plans or reviews.
- Therefore acceptance is based on eliminating redundant turns and repeated context loading, not on claiming zero-token delivery or an exact percentage saving. Exact savings depend on thread history, result length, model caching, and whether the user would otherwise poll or manually recover.

The implementation must preserve the compact callback prompt and must not add raw result text to the RPC notification payload. A future result-summarization or path-only mode would be a separate product decision because it could reduce fidelity of automatic writeback.

### Zero-model-polling invariant

The accepted token boundary is stricter than merely “fewer retries”:

1. `thread/resume` is one system-level App Server RPC used to read the target task state; it does not invoke the Codex model.
2. `turn/start` is sent once per delivery attempt and starts the one callback model turn that is allowed to consume the returned result.
3. After acceptance, the Node notification worker waits by reading App Server notifications from stdout until the matching `turn/completed`. It must not ask the model to check status.
4. Outbox lease renewal is a Node timer plus local durable-state update. It must not create a Codex turn or call an MCP status tool.
5. The waiting path must make zero calls to `mimo_status`, `mimo_events`, or `mimo_wait`, and zero additional calls to `turn/start`.
6. The callback model turn may call `mimo_result` once and generate the user-facing response. This is normal result-consumption cost and is not treated as polling overhead.

Tests and the real callback audit must prove one `thread/resume`, one `turn/start`, one completed callback turn, and no model-driven progress checks between start and completion.

## Considered approaches

### Approach A — one connection through terminal turn lifecycle (selected)

Start the callback turn on the prepared stdio client, retain the connection, match lifecycle notifications to the returned `turnId`, and close only after a terminal status or classified failure.

Advantages:

- Matches the documented App Server lifecycle.
- Smallest change to the current prepared-connection architecture.
- Gives the outbox `delivered` state a truthful meaning.
- Keeps per-attempt process isolation and existing cleanup guarantees.

Cost:

- The notify worker holds one delivery lease while the callback agent runs.
- The client needs an in-memory waiter and a completion timeout distinct from the RPC request timeout.

### Approach B — shared long-lived App Server process

Keep a daemon or pooled connection and route multiple callback turns through it.

Rejected because it adds process supervision, concurrent turn routing, reconnection, authentication lifetime, shutdown ordering, and cross-workspace isolation to a single-delivery correctness fix.

### Approach C — start then reconnect and inspect the thread

Close after `turn/start`, create another App Server client, and infer completion from thread history or status.

Rejected because closing the owning stdio App Server is the behavior that interrupts the turn. Reconnection also introduces polling races and cannot reliably distinguish the requested callback turn from later user activity.

## Architecture

The existing notification pipeline remains:

```text
job terminal transition
  -> attention signal
  -> durable outbox record
  -> notify worker claims + renews lease
  -> prepare Codex connection and resume target thread
  -> start callback turn
  -> wait for matching terminal turn notification
  -> settle outbox
```

Only the Codex delivery boundary changes:

```text
current
  turn/start accepted -> delivered -> close -> callback turn interrupted

selected
  turn/start accepted
    -> capture turnId
    -> keep reading notifications
    -> matching turn/completed
       -> completed   -> delivered -> close
       -> interrupted -> retry     -> close
       -> failed      -> retry     -> close
    -> timeout/transport/protocol failure -> retry or permanent classification -> close
```

The webhook adapter and its short HTTP request timeout remain unchanged.

## Component design

### 1. App Server lifecycle client

`src/notify/codex-app-server.ts` will own protocol parsing and lifecycle waiting.

The public client interface will expose a single operation whose result cannot be mistaken for mere RPC acceptance:

```ts
export type CodexTurnTerminalStatus = "completed" | "interrupted" | "failed";

export interface CodexTurnCompletion {
  turnId: string;
  status: CodexTurnTerminalStatus;
}

export interface CodexAppServerClient {
  initialize(signal?: AbortSignal): Promise<void>;
  resumeThread(threadId: string, signal?: AbortSignal): Promise<ThreadResumeResult>;
  startTurnAndWait(
    threadId: string,
    prompt: string,
    signal?: AbortSignal
  ): Promise<CodexTurnCompletion>;
  close(): Promise<void>;
}
```

`startTurnAndWait()` performs these steps:

1. Send `turn/start` and validate the existing response schema.
2. Read the exact `turn.id` and response status.
3. If the response is already terminal, return it immediately.
4. If it is `inProgress`, register a waiter keyed by `turnId` and bound to the requested `threadId`.
5. Continue consuming App Server notifications.
6. Resolve only when a valid matching `turn/completed` notification supplies `completed`, `interrupted`, or `failed`.

The client will buffer a terminal lifecycle notification that arrives before the waiter is registered. This avoids relying on response/notification scheduling order. The buffer is in memory, stores only thread id, turn id, and status, and is cleared when consumed or when the client closes.

Recognized `turn/completed` notifications with an invalid schema cause `codex_app_server_incompatible`; unrelated valid notifications continue to be ignored. Notifications for other thread or turn ids must not settle the active waiter.

### 2. Completion budget and cancellation

RPC request timeout and callback completion timeout are different controls:

| Budget | Value | Purpose |
|--------|-------|---------|
| RPC request timeout | existing effective value, normally 10 seconds | Bound `initialize`, `thread/resume`, and `turn/start` request/response exchanges. |
| Callback turn completion timeout | 300,000 ms (5 minutes) | Bound the agent turn from accepted start through `turn/completed`. |
| Outbox lease | existing 30 seconds, continuously renewed | Preserve ownership while the callback turn runs. |
| Outbox retry age | existing 1,800,000 ms (30 minutes) | Limit total retry lifetime. |

The five-minute callback budget is internal and test-injectable, not a new public work-tool option. The callback prompt is intentionally narrow (`mimo_result` plus original-request continuation), so five minutes is a stop-loss rather than a normal target.

Lease ownership loss or an external abort rejects the waiter and tears down the App Server client. Timeout cleanup removes the waiter and timer before teardown. Closing a client with an unresolved waiter rejects it; it must never leave a pending promise or timer.

### 3. Adapter settlement semantics

`src/notify/codex-adapter.ts` will call `startTurnAndWait()` and classify the terminal result:

| Callback outcome | Delivery result |
|------------------|-----------------|
| `completed` | `{ outcome: "delivered" }` |
| `interrupted` | retry with `codex_turn_interrupted` |
| `failed` | retry with `codex_turn_failed` |
| completion budget expires | retry with `codex_turn_timeout` |
| transport unavailable | existing retryable `codex_app_server_unavailable` |
| malformed/incompatible protocol | existing permanent `codex_app_server_incompatible` |
| missing/forbidden target | existing permanent target code |
| busy target before start | existing retryable `codex_thread_busy` |

The adapter still closes the client in `finally`, but only after `startTurnAndWait()` has settled. Close failure remains secondary and cannot overwrite the primary delivery outcome.

The new public-safe errors are fixed strings:

- `codex_turn_interrupted`: `Codex callback turn was interrupted`
- `codex_turn_failed`: `Codex callback turn failed`
- `codex_turn_timeout`: `Codex callback turn timed out`

Raw App Server error text, turn items, and callback output are never copied into the outbox or MCP results.

### 4. Durable delivery and retry behavior

`src/notify/types.ts`, outbox validation, status/result rendering, and tests will accept the three new notification error codes. They remain retryable in `classifyCodexError()`.

No new delivery status is required. Existing states retain these meanings:

- `pending`: eligible now or at `nextAttemptAt`.
- `delivering`: one worker owns the renewable lease and may be waiting for the callback turn.
- `delivered`: the matching callback turn completed successfully.
- `failed`: a permanent failure occurred or the existing maximum retry age was exceeded.

Retries may create another callback turn if connection loss makes the previous outcome unknowable. This preserves the existing at-least-once contract. The prompt's frozen event id and “may be a retry” wording remain unchanged. Exactly-once deduplication is outside this change.

### 5. Connection preparation

`src/notify/codex-connection.ts` continues to resolve a CLI candidate, initialize one client, and resume the exact target thread before delivery. Busy, missing, forbidden, incompatible, and executable-discovery behavior stays unchanged.

Preparation must not start the callback turn and must not wait for turn completion. Ownership of the prepared client transfers to the adapter exactly as today; every accepted or rejected path still closes it once.

## Error and cleanup invariants

1. No outbox record becomes `delivered` before a matching successful terminal event.
2. A `turn/start` response with `inProgress` is not a delivery outcome.
3. An unrelated turn notification cannot settle the callback delivery.
4. Every waiter settles once and removes its timer, abort listener, and map entry.
5. Protocol failure rejects all pending RPC requests and turn waiters with the same terminal client error.
6. Transport exit before callback completion is retryable unless a more specific permanent error is already known.
7. `close()` remains idempotent and bounded by the existing EOF, `SIGTERM`, and `SIGKILL` sequence.
8. Lease renewal continues for the entire completion wait; ownership loss aborts delivery before outbox settlement.
9. Callback completion does not modify the MiMo job's already-terminal status.
10. Webhook delivery behavior and timeouts do not change.

## Testing strategy

### Unit: App Server protocol client

Add deterministic cases to `test/unit/notify/codex-app-server.test.ts`:

- `turn/start` returns `inProgress`; the returned promise remains pending until matching `turn/completed`.
- Successful completion resolves `{ turnId, status: "completed" }`.
- `interrupted` and `failed` terminal notifications resolve their exact status.
- A terminal status in the `turn/start` response resolves without waiting.
- A terminal notification received before waiter registration is buffered and consumed.
- Notifications for another thread or turn are ignored.
- Malformed recognized `turn/completed` frames reject as protocol incompatible.
- Completion timeout rejects with `codex_turn_timeout` and triggers bounded teardown.
- Abort, child exit, and stream error reject outstanding waiters and release resources.
- `close()` with a pending waiter leaves no active timer, listener, or unresolved promise.

### Unit: adapter and classification

Update `test/unit/notify/codex-adapter.test.ts`:

- Completed callback is delivered and the client closes afterward.
- Assert the client is not closed while completion is still pending.
- Interrupted, failed, and timed-out callbacks return retry results with the new safe codes.
- Existing permanent target/protocol classifications remain unchanged.
- Best-effort close failure never replaces the primary callback result.

### Unit: dispatcher, outbox, and rendering

Update notification tests to prove:

- A long callback wait renews its outbox lease and does not become stale.
- `deliveredAt` is written after callback completion, not after `turn/start` acceptance.
- Interrupted/failed/timeout results return to `pending` with existing retry delay rules.
- The three error codes survive JSONL round-trip and appear in `mimo_status` / `mimo_result` notification summaries.
- Webhook attempts retain the existing short timeout path.

### Integration: fake App Server

Use the existing fake-process boundary to run:

```text
initialize -> thread/resume(idle) -> turn/start(inProgress)
  -> verify outbox still delivering
  -> turn/completed(completed)
  -> verify outbox delivered
```

Add an interrupted variant that verifies retry scheduling and confirms no false `deliveredAt`.

### Installed-package smoke

Strengthen `test/smoke/local-codex-notification.test.ts` so the opt-in Windows smoke requires all of the following:

1. The independently resumed task calls `mimo_result` exactly once and writes the expected marker.
2. The marker includes the expected final output token.
3. The notification outbox is `delivered` only after the marker-producing callback turn completes.
4. The originating task's callback turn is non-empty and completed, not merely started.
5. Audit expectations still show one target resume and one callback `turn/start` for the successful path.

The real smoke remains gated by `RUN_LOCAL_CODEX_NOTIFY_SMOKE=1`, but deterministic fake-App-Server lifecycle tests run in the ordinary test suite so this regression cannot depend solely on the optional smoke.

## Documentation and user contract

Update `skills/mimocode/SKILL.md`, `README.md`, and `doc/operations-guide.md` to state:

- `delivered` means the callback turn completed, not merely that Codex accepted `turn/start`.
- The callback turn is responsible for calling `mimo_result` and continuing the original request.
- Callback interruption, failure, and timeout are retried through the durable outbox.
- Operators should inspect notification status/error code only for explicit diagnostics; normal callers still do not poll.
- A successful callback is separate from MiMo `session.post` execution evidence.

Do not claim exactly-once delivery.

## Implementation boundaries and likely files

| Responsibility | Files |
|----------------|-------|
| Turn lifecycle types, parsing, waiters, cleanup | `src/notify/codex-app-server.ts` |
| Terminal result classification and truthful delivery | `src/notify/codex-adapter.ts` |
| New safe notification error codes | `src/notify/types.ts` |
| Lease/settlement integration if test seams are needed | `src/notify/dispatcher.ts` |
| Protocol lifecycle unit coverage | `test/unit/notify/codex-app-server.test.ts` |
| Adapter outcome coverage | `test/unit/notify/codex-adapter.test.ts` |
| Retry, lease, and persistence coverage | `test/unit/notify/dispatcher.test.ts`, `test/unit/notify/outbox.test.ts` |
| Installed callback proof | `test/smoke/local-codex-notification.test.ts`, smoke support only where required |
| Public workflow contract | `skills/mimocode/SKILL.md`, `README.md`, `doc/operations-guide.md` |

No new production file is required unless implementation makes the lifecycle parser materially clearer as a focused `src/notify/codex-turn-lifecycle.ts` module. The implementation plan should prefer keeping it in `codex-app-server.ts` unless that file becomes difficult to test or review.

## Parallel implementation boundaries

Work may be parallelized only after the lifecycle interfaces and error-code names above are frozen:

1. **Protocol lane:** App Server lifecycle client plus its unit tests.
2. **Settlement lane:** adapter/types/outbox/dispatcher classification and tests, using the frozen `startTurnAndWait()` interface.
3. **Acceptance lane:** deterministic integration fixture and installed smoke strengthening.
4. **Documentation lane:** SKILL, README, and operations guide wording.

The protocol and settlement lanes touch adjacent types and must integrate through the exact interfaces in this design. Acceptance and documentation lanes can proceed independently. Final integration, full verification, plugin build, plugin validation, and installed-cache refresh are sequential gates after all lanes merge.

## Verification and acceptance

Required automated verification:

```powershell
npm.cmd test -- codex-app-server.test.ts
npm.cmd test -- codex-adapter.test.ts
npm.cmd test -- dispatcher.test.ts
npm.cmd test -- outbox.test.ts
npm.cmd run lint
npm.cmd test
npm.cmd run build
npm.cmd run validate:plugin
```

When the local Codex Desktop and standalone callback CLI prerequisites are available:

```powershell
$env:RUN_LOCAL_CODEX_NOTIFY_SMOKE='1'
npm.cmd run test:smoke:codex-notify
```

Acceptance requires a fresh dedicated Codex task to demonstrate this sequence:

1. Launch one MiMoCode work job with explicit Codex notification target.
2. Stop the originating turn after receiving the queued receipt; do not poll.
3. MiMoCode job reaches an attention terminal state.
4. The outbox starts delivery but does not settle on `turn/start` acceptance.
5. The automatic callback turn calls `mimo_result`, writes a non-empty final response in the originating task, and reaches `completed`.
6. Only then does the outbox show `delivered` with `deliveredAt`.
7. No empty 117 ms-style `interrupted` callback turn is present.

## Rollout and compatibility

1. Implement with TDD and keep commits separated by protocol lifecycle, settlement semantics, acceptance coverage, and docs.
2. Run the ordinary full suite before any plugin refresh.
3. Build and validate the plugin.
4. Refresh the personal plugin cache using the repository's build/install workflow.
5. Restart Codex Desktop so the packaged MCP server loads the new build.
6. Run the opt-in real callback smoke from a dedicated idle task.
7. Run one manual Compose `plan` callback and confirm automatic writeback.

The change is additive to internal notification error codes and does not change work-tool request schemas, queued receipts, job terminal states, webhook payloads, or existing job artifacts. Old outbox records remain readable because the delivery status schema is unchanged.

## Success criteria

- A completed MiMoCode job with a valid Codex target automatically produces a non-empty completed callback turn in the originating task.
- `deliveredAt` is later than or equal to the matching callback turn completion time.
- An interrupted callback never appears as delivered.
- Deterministic lifecycle tests run in the normal suite and reproduce the pre-fix false-positive behavior.
- The installed-package smoke proves `mimo_result.output` reached the resumed task.
- Full tests, type checking, build, and plugin validation pass.
- No unrelated source files or existing untracked plans are modified.
