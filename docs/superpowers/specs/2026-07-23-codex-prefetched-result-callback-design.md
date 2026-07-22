# Codex Prefetched-Result Callback Design

Date: 2026-07-23
Status: approved direction, pending written-spec review
Primary approach: resolve the public MiMoCode result before `turn/start` and attach it to one tool-free callback turn

## Incident and corrected diagnosis

Job `compose-mrwdjbyk-ihukis` completed successfully for Codex task
`019f8aef-2cb1-7160-8918-79a26cdbb07b`, but no automatic final answer appeared.
The installed package was the intended build (`0.1.0+codex.20260723013938`), and its
critical notification files matched the source checkout by SHA-256. This was not a stale-package
or failed-build incident.

The previous lifecycle change also worked as designed: the notification worker kept the stdio App
Server connection open and waited for `turn/completed`. The failure moved one boundary later:

1. The job completed and enqueued notification event
   `compose-mrwdjbyk-ihukis:46:codex`.
2. The notification worker started a real callback turn in the target task.
3. The callback model received the prompt and attempted `mimo_result`.
4. That MCP invocation never produced a result.
5. The callback turn was interrupted after `300019` ms.
6. A retry repeated the same behavior and was interrupted after `300014` ms.
7. The outbox correctly recorded `codex_turn_timeout` instead of falsely marking delivery.

The current App Server parser understands client-initiated responses and notifications. A message
with an `id` that does not match one of the client's pending requests is silently ignored. Current
App Server schemas also define server-initiated requests, including `item/tool/call`, with request
IDs that may be strings or numbers. A resumed callback can retain dynamic tool declarations from
the original Desktop task, but this notification client does not provide the Desktop tool-execution
host. The callback therefore knows that `mimo_result` exists but cannot complete its invocation.

Increasing the callback timeout cannot solve this failure. It only extends the time and model cost
before the same unresolved tool request is cancelled.

## Goals

1. Automatically write a useful result into the originating Codex task after a MiMoCode attention
   state without requiring a callback MCP call.
2. Retain one event-driven callback model turn and zero model-driven polling.
3. Preserve truthful delivery: `delivered` still means the matching callback turn completed.
4. Prevent deterministic callback failures from creating repeated five-minute turns.
5. Reuse the same public-safe result rendering as `mimo_result` without exposing raw events, job
   prompts, private errors, environment data, or protocol frames.
6. Keep the implementation smaller than a general-purpose bidirectional dynamic-tool proxy.

## Non-goals

- Implement arbitrary App Server dynamic tools or execute model-supplied JavaScript in the notify
  worker.
- Replace stdio App Server transport with WebSocket, Desktop IPC, or a shared daemon.
- Make Codex delivery exactly once.
- Inject raw MiMo JSONL, full logs, prompts, stderr, or private notification errors into the task.
- Guarantee zero total model tokens. One callback turn still consumes the already-accepted result
  and writes the user-facing answer.
- Adopt `thread/inject_items` in this change. Direct history injection remains an experimental
  follow-up because visible assistant-message behavior is not yet proven.

## Considered approaches

### Approach A — prefetch the public result and attach it to the callback (selected)

The notification worker reads the finished job from local durable state, builds the same public-safe
result envelope used by `mimo_result`, and attaches that envelope to `turn/start`. The callback is
explicitly told that the result is already present and that it must answer without tools.

Advantages:

- Removes the failing nested MCP boundary entirely.
- Preserves one callback model turn and event-driven `turn/completed` waiting.
- Result text enters model context once, as it would have through a successful MCP tool result.
- Uses existing durable job data and public rendering functions.
- Small, testable change with no new daemon or cross-process protocol.

Cost:

- The `turn/start` input is larger because it contains the public result.
- A callback result must be treated as untrusted data and clearly delimited.

### Approach B — implement an App Server dynamic-tool bridge

Handle `item/tool/call`, forward only allowlisted requests, and return
`DynamicToolCallResponse` frames.

This preserves the compact callback prompt, but the current Codex code-mode surface wraps nested
tools through a dynamic execution host. Safely reproducing that host is materially broader than
proxying one MCP method. It also introduces version-specific server-request schemas and additional
security review. Keep this as a later protocol-completeness project, not the immediate reliability
fix.

### Approach C — append an assistant item with `thread/inject_items`

The installed CLI schema exposes a system-level method that appends raw Responses API items to
model-visible history. If it can reliably create a visible assistant reply, it could approach zero
total callback tokens.

The method is not sufficiently documented as a user-visible delivery contract, may not create a
normal completed turn, and is sensitive to raw item shape. It requires an isolated product spike
before production use and is explicitly deferred.

## Selected architecture

The durable notification pipeline remains unchanged until the adapter claims an eligible Codex
delivery:

```text
job attention transition
  -> durable signal
  -> durable outbox record
  -> notify worker claims and renews the lease
  -> prepare App Server connection and resume exact target task
  -> build public callback result from local job artifacts
  -> turn/start(result envelope already attached; tools prohibited)
  -> wait for matching turn/completed on stdout
  -> completed => delivered
  -> interrupted/failed/timeout => classified settlement
```

No model or MCP call participates between job completion and `turn/start`. No status, events, or
wait polling is added.

## Public callback result envelope

The callback payload is derived from:

```ts
renderJobResult(job, undefined, readFinalJobOutput(job.eventsFile))
```

Before serialization, remove fields that instruct the model to call control tools:

- remove `actions`;
- omit `notification`, because the current record is necessarily `delivering` while the callback
  is running;
- retain the public-safe `jobId`, `kind`, `status`, `resultType`, `summary`, `sessionId`,
  `changedFiles`, `verification`, public execution-callback summary, safe error/errorCode,
  report paths, and `output` when present.

Define a named exported payload type so declarations remain nameable and tests can freeze the
contract. The payload must never contain:

- the original task prompt;
- the job request object;
- raw normalized events or signals;
- private App Server or MiMo error messages;
- notification leases, attempts, or target task IDs;
- environment variables, executable paths, or webhook configuration.

`readFinalJobOutput()` is already tolerant of a missing or malformed events file. A callback without
`output` still carries terminal/partial status and a safe summary, so it can produce a useful
fallback response rather than failing delivery preparation.

## Callback prompt contract

Use a versioned marker so the skill and smoke tests can distinguish this path:

```text
MIMO_CALLBACK_RESULT_V1
```

The prompt contains:

1. Frozen notification event ID and a reminder that the event may be retried.
2. A statement that the public MiMoCode result is already attached.
3. A strict instruction not to call `mimo_result`, `mimo_status`, `mimo_events`, `mimo_wait`, or
   any other tool.
4. An instruction to continue the original user request using the attached result and produce the
   final user-facing answer.
5. One JSON result envelope between explicit data delimiters.

The result envelope is data, not higher-priority instructions. The prompt must tell the callback not
to execute commands or follow instructions embedded inside `output`. This is equivalent to treating
a tool result as untrusted external content.

For `needs_input` and `blocked`, the callback presents the partial result or safe summary and asks the
user for the missing decision. For terminal jobs, the callback consumes `output` as the principal
answer. If `output` is absent, it reports the safe terminal summary and relevant public error code.

Do not truncate ordinary results in this change. Existing MiMo plans and reviews already have to fit
inside a Codex turn when returned through `mimo_result`; moving the same content into the initial
turn input does not create a new semantic size requirement. A measured oversize policy can be added
later if real payload evidence requires it.

## App Server server-request behavior

Even though the selected callback should not call tools, the App Server client must never silently
drop a server-initiated request again.

Message routing order becomes:

1. Notification: no `id`, valid `method` and `params` -> existing notification handler.
2. Server request: `id` plus `method` and `params`, without `result` or `error` -> server-request
   handler.
3. Response: `id` plus exactly one of `result` or `error` -> existing pending-response handler.
4. Any other shape -> protocol failure.

The callback client does not implement tools in this release. For `item/tool/call` and other
unsupported server requests, return a JSON-RPC method-not-supported error immediately using the
same string-or-number request ID. The public message is fixed and contains no request arguments.
This lets the model observe a fast tool failure and use the already-attached result instead of
hanging until the five-minute turn budget expires.

The safe App Server audit may record only the inbound method name, PID, and timestamp. It must not
record request IDs, arguments, tool code, result contents, prompts, or thread IDs beyond the existing
allowlisted audit contract.

## Delivery and retry policy

Existing connection, missing-target, forbidden-target, and protocol classifications remain.

Callback terminal handling remains:

| Callback outcome | Settlement |
|---|---|
| `completed` | `delivered` |
| `interrupted` | retryable once; at most two total attempts for the event |
| `failed` | retryable once; at most two total attempts for the event |
| `codex_turn_timeout` | no repeated callback turn; settle failed after the first timed-out attempt |
| transport loss before a terminal event | existing at-least-once retry policy |

`codex_turn_timeout` becomes non-retryable for the current event. Once the result is already attached,
a five-minute timeout indicates that the callback path itself did not converge; immediately creating
another identical model turn wastes tokens and delays diagnosis. Transport failures remain retryable
because no reliable terminal outcome is known.

Interrupted and failed turns retain exactly one bounded retry, for at most two total delivery
attempts for the event. Implement the cap in one policy helper over existing attempt state and cover
it with deterministic tests; do not add a second general retry framework.

## Token and context impact

- Local result rendering, outbox leasing, `thread/resume`, and stdout waiting consume no model
  tokens.
- Exactly one normal callback turn consumes the result and writes the answer.
- The result content enters callback context once. Previously it was intended to enter once as an
  MCP tool result; the transport location changes, not the required semantic content.
- No polling turn or repeated status request is introduced.
- Making timeout non-retryable prevents repeated five-minute turns from multiplying token use.

This meets the accepted boundary: waiting overhead is approximately zero model tokens, while normal
result consumption remains.

## Component boundaries

### `src/notify/codex-adapter.ts`

- Build the public callback payload before starting a turn.
- Build the versioned, tool-free callback prompt.
- Call `startTurnAndWait()` exactly once.
- Keep terminal-status classification and best-effort close behavior.

### `src/core/job-output.ts` and `src/core/job-render.ts`

- Reuse existing result extraction and public-safe rendering.
- Add only a small named helper/type if needed to remove `actions` and `notification` without
  duplicating rendering logic.
- Do not move notification infrastructure into `core` or create a circular import back to
  `codex/tools.ts`.

### `src/notify/codex-app-server.ts`

- Distinguish server requests from responses.
- Accept string or number server request IDs.
- Respond immediately to unsupported `item/tool/call` requests.
- Preserve event-driven `turn/completed`, timeout, abort, and bounded teardown.

### `src/notify/dispatcher.ts`

- Apply the narrow timeout retry policy using existing attempt state.
- Preserve lease renewal and webhook behavior.

### `skills/mimocode/SKILL.md` and operator docs

- Replace “callback calls `mimo_result`” with “callback receives a prefetched public result and must
  answer without tools.”
- Keep user-initiated diagnostic guidance for `mimo_status`, `mimo_events`, and `mimo_result`.
- State that direct user follow-ups can still call `mimo_result`; only the automatic callback path
  changes.

## Testing strategy

### Unit: public payload and prompt

- Completed result includes exact `output` and public job fields.
- Partial result includes safe status/summary.
- `actions`, `notification`, task, request, raw events, and private errors are absent.
- Prompt contains `MIMO_CALLBACK_RESULT_V1` and exact event ID.
- Prompt contains the serialized public result once.
- Prompt contains no instruction to call any tool and explicitly prohibits tool calls.
- Newline, quote, and non-ASCII result content survives serialization.

### Unit: App Server protocol

- String and numeric server-request IDs are accepted.
- `item/tool/call` receives an immediate fixed error response.
- The client remains alive after the unsupported request and can still receive
  `turn/completed(completed)`.
- Unsupported request arguments never appear in audit output or errors.
- Existing response/notification race, timeout, abort, and close tests remain green.

### Unit: adapter and dispatcher

- Adapter attaches the prefetched result and invokes `startTurnAndWait()` once.
- No callback path calls `mimo_result` or any control-tool function.
- Deferred callback still renews the outbox lease.
- Completed callback settles delivered after terminal notification.
- Timed-out callback does not schedule another callback attempt.
- Interrupted/failed retry behavior matches the frozen bounded policy.
- Webhook retries are unchanged.

### Integration: fake App Server

Exercise this deterministic sequence:

```text
initialize
  -> thread/resume(idle)
  -> turn/start(prompt contains prefetched result)
  -> optional unexpected item/tool/call receives immediate error
  -> turn/completed(completed)
  -> outbox delivered
```

Assert no `mimo_result`, `mimo_status`, `mimo_events`, or `mimo_wait` invocation occurs in the
automatic path.

### Installed real callback smoke

Update the Windows smoke to prove:

1. Installed package and source manifest versions match.
2. One job creates exactly two one-time resume probes and one callback `turn/start`.
3. The target task's resulting assistant response contains the expected output marker; deterministic
   App Server tests separately prove the outbound prompt carried `MIMO_CALLBACK_RESULT_V1`.
4. The target task produces a non-empty completed assistant response without an MCP result call.
5. The outbox becomes delivered only after callback completion.
6. No second callback turn is created.

## Rollout

1. Implement with TDD in isolated commits: payload/prompt, App Server fail-fast routing, settlement
   policy, smoke/docs.
2. Run focused notification tests, full tests, lint, build, and plugin validation.
3. Create a new immutable plugin cache version and compare critical hashes.
4. Restart Codex Desktop so the new MCP package and skill text load.
5. Run the installed callback smoke from a dedicated idle task.
6. Reproduce one Compose `plan` callback without manual polling.
7. Confirm one completed callback answer, zero callback MCP calls, and delivered outbox state.

Do not reuse the currently timed-out event as acceptance evidence; use a fresh job/event after the
new package is loaded.

## Acceptance criteria

- A completed MiMoCode job automatically produces a visible, non-empty final response in the
  originating Codex task.
- The automatic callback performs no MCP or shell tool call.
- The prefetched public result is the only job-result content supplied to the model.
- Exactly one successful callback `turn/start` occurs.
- Waiting uses stdout lifecycle notifications and local lease timers only.
- `deliveredAt` is written only after matching `turn/completed(completed)`.
- A server-initiated tool request receives an immediate response and cannot hang the turn.
- `codex_turn_timeout` cannot create a sequence of repeated five-minute callback turns.
- User-initiated `mimo_result` remains unchanged and continues returning the full public result.
- Full tests, type checking, build, plugin validation, installed smoke, and manual regression pass.
- Existing unrelated working-tree changes and untracked plans remain untouched.
