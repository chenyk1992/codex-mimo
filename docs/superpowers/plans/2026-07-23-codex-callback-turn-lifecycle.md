# Codex Callback Turn Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex notification delivery event-driven and truthful: system code waits for the matching callback `turn/completed`, performs zero model-driven polling, and marks the outbox delivered only after the callback turn completes.

**Architecture:** Keep the existing one-process-per-delivery stdio App Server architecture. Extend the client with `startTurnAndWait()`, route `turn/completed` notifications to an in-memory waiter, and let the notify worker renew its durable lease while the Node process waits; only the single callback turn may call `mimo_result` and generate the final response.

**Tech Stack:** TypeScript 5.7, Node.js ESM/NodeNext, Vitest 2, Codex App Server JSONL RPC over stdio, durable JSONL notification outbox, MCP SDK.

## Global Constraints

- Preserve ESM `.js` import suffixes in TypeScript source and tests.
- Keep `stdin: "ignore"` for MiMo runs; this plan changes only Codex notification delivery.
- One full notified job may issue two system-only `thread/resume` calls: launch preflight and delivery preparation.
- One delivery attempt may issue exactly one `turn/start`; it must not issue another resume or start while waiting.
- Waiting must use App Server stdout notifications and Node timers only; never call `mimo_status`, `mimo_events`, or `mimo_wait`.
- The callback prompt remains compact and contains only frozen event id, cwd, job id, and the instruction to call `mimo_result`.
- Only `mimo_result` plus final response generation may consume callback-model tokens.
- `delivered` means the matching callback turn reached `status: "completed"`; RPC acceptance alone is insufficient.
- Callback completion timeout is internal, test-injectable, and defaults to `300_000` ms.
- `interrupted`, `failed`, and completion timeout are retryable; protocol incompatibility and inaccessible targets remain permanent.
- Preserve at-least-once semantics, existing retry delays, 30-minute maximum retry age, and renewable outbox leases.
- Do not persist prompts, model output, turn items, RPC frames, stderr, executable paths, or environment values.
- Do not change webhook delivery, job terminal states, work-tool schemas, or queued receipt shapes.
- Preserve all unrelated untracked documents already present in `docs/superpowers/plans/`.

## Reference Design

Read before implementation:

`docs/superpowers/specs/2026-07-23-codex-callback-turn-lifecycle-design.md`

## File Responsibility Map

| File | Responsibility |
|------|----------------|
| `src/notify/codex-app-server.ts` | Turn lifecycle types, start response parsing, notification routing, completion waiter, timeout/abort/close cleanup. |
| `src/notify/codex-adapter.ts` | Map terminal callback outcomes to durable delivery results and public-safe errors. |
| `src/notify/types.ts` | Register new persisted notification error codes. |
| `src/notify/dispatcher.ts` | Preserve renewable ownership while Codex delivery waits; no model polling. |
| `test/unit/notify/codex-app-server.test.ts` | Deterministic JSONL lifecycle, race, timeout, and cleanup coverage. |
| `test/unit/notify/codex-adapter.test.ts` | Truthful settlement and error classification coverage. |
| `test/unit/notify/dispatcher.test.ts` | Lease renewal and delayed settlement coverage. |
| `test/unit/notify/outbox.test.ts` | New error-code persistence and retry round-trip coverage. |
| `test/smoke/local-codex-notification.test.ts` | Installed-package proof of one start, zero model polling, `mimo_result`, and completed writeback. |
| `skills/mimocode/SKILL.md`, `README.md`, `doc/operations-guide.md` | Public zero-poll and delivered-state contract. |

## Parallel Execution Map

```text
Wave 0 (sequential contract gate)
  Task 1 — freeze App Server lifecycle interface

Wave 1 (parallel)
  Task 2 — lifecycle waiting, timeout, cleanup
  Task 6 — documentation contract

Wave 2 (parallel after Task 2)
  Task 3 — adapter and error-code settlement
  Task 4 — outbox lease and zero-poll persistence tests

Wave 3 (after Tasks 2–4)
  Task 5 — installed-package and end-to-end callback proof

Wave 4 (sequential integration gate)
  Task 7 — full verification, build, plugin validation, refresh, manual acceptance
```

Task 2 owns the lifecycle implementation in `codex-app-server.ts`; after Task 2 merges, Task 3 may only remove the transitional `startTurn()` declaration/implementation from that file while switching the adapter. Task 4 owns dispatcher/outbox tests and does not edit production dispatcher code. Task 6 owns documentation files only. This ownership keeps each parallel wave mergeable.

---

### Task 1: Freeze the turn lifecycle contract

**Files:**
- Modify: `src/notify/codex-app-server.ts:12-70`
- Modify: `src/notify/types.ts:11-20`
- Modify: `test/unit/notify/codex-app-server.test.ts:99-101`
- Test: `test/unit/notify/codex-app-server.test.ts`

**Interfaces:**
- Consumes: existing initialized `CodexAppServerClient` and validated `turn/start` result shape.
- Produces: `CodexTurnTerminalStatus`, `CodexTurnCompletion`, `startTurnAndWait(threadId, prompt, signal?)`, and the three frozen notification error codes used by Tasks 2–4. The old `startTurn()` remains only as a compile-safe transition seam until Task 3.

- [ ] **Step 1: Generalize the test helper and add an immediate-terminal failing test**

Replace `turnStartResult()` and add this test beside the existing turn-start result tests:

```ts
function turnStartResult(
  id = "turn-1",
  status: "inProgress" | "completed" | "interrupted" | "failed" = "inProgress"
): Record<string, unknown> {
  return { turn: { id, status, items: [] } };
}

it("returns an already terminal turn without waiting for a notification", async () => {
  const client = await initializeClient(process);
  const completed = client.startTurnAndWait("thread-1", "continue");
  const [{ id }] = messagesFrom(process) as Array<{ id: number }>;

  respond(process, { id, result: turnStartResult("turn-terminal", "completed") });

  await expect(completed).resolves.toEqual({
    turnId: "turn-terminal",
    status: "completed"
  });
  await client.close();
});
```

- [ ] **Step 2: Run the focused test and confirm the contract is missing**

Run:

```powershell
npm.cmd test -- codex-app-server.test.ts
```

Expected: TypeScript/Vitest failure reporting that `startTurnAndWait` does not exist on `CodexAppServerClient`.

- [ ] **Step 3: Add the exported lifecycle types and transition interface**

Add the new method while temporarily retaining the old method:

```ts
export type CodexTurnTerminalStatus = "completed" | "interrupted" | "failed";

export interface CodexTurnCompletion {
  turnId: string;
  status: CodexTurnTerminalStatus;
}

export interface CodexAppServerClient {
  initialize(signal?: AbortSignal): Promise<void>;
  resumeThread(threadId: string, signal?: AbortSignal): Promise<ThreadResumeResult>;
  startTurn(threadId: string, prompt: string, signal?: AbortSignal): Promise<void>;
  startTurnAndWait(
    threadId: string,
    prompt: string,
    signal?: AbortSignal
  ): Promise<CodexTurnCompletion>;
  close(): Promise<void>;
}
```

Append the frozen codes to `NOTIFICATION_ERROR_CODES` in `src/notify/types.ts`:

```ts
"codex_turn_interrupted",
"codex_turn_failed",
"codex_turn_timeout"
```

Add these safe readers near `isTurnStartResult()`:

```ts
function readTurnStart(
  value: unknown
): { turnId: string; status: "inProgress" | CodexTurnTerminalStatus } {
  if (!isTurnStartResult(value)) {
    throw new CodexAppServerError(
      "codex_app_server_incompatible",
      "Invalid Codex turn response"
    );
  }
  return {
    turnId: value.turn.id as string,
    status: value.turn.status as "inProgress" | CodexTurnTerminalStatus
  };
}

function isTerminalTurnStatus(value: string): value is CodexTurnTerminalStatus {
  return value === "completed" || value === "interrupted" || value === "failed";
}
```

- [ ] **Step 4: Implement immediate-terminal support beside the existing start method**

Keep `startTurn()` unchanged for the existing adapter and add:

```ts
async startTurnAndWait(
  threadId: string,
  prompt: string,
  signal?: AbortSignal
): Promise<CodexTurnCompletion> {
  this.requireInitialized();
  const result = await this.request("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt }]
  }, signal);
  const started = readTurnStart(result);
  if (isTerminalTurnStatus(started.status)) {
    return { turnId: started.turnId, status: started.status };
  }
  return this.waitForTurnCompletion(threadId, started.turnId, signal);
}
```

Add the method signature and a map-backed minimal implementation that Task 2 will harden:

```ts
private readonly terminalTurns = new Map<string, CodexTurnCompletion & { threadId: string }>();
private readonly turnWaiters = new Map<string, {
  threadId: string;
  resolve: (completion: CodexTurnCompletion) => void;
  reject: (error: CodexAppServerError) => void;
}>();

private waitForTurnCompletion(
  threadId: string,
  turnId: string,
  _signal?: AbortSignal
): Promise<CodexTurnCompletion> {
  const buffered = this.terminalTurns.get(turnId);
  if (buffered?.threadId === threadId) {
    this.terminalTurns.delete(turnId);
    return Promise.resolve({ turnId, status: buffered.status });
  }
  return new Promise((resolve, reject) => {
    this.turnWaiters.set(turnId, { threadId, resolve, reject });
  });
}
```

- [ ] **Step 5: Keep existing start-only tests on the compatibility method**

Only the new immediate-terminal test uses `startTurnAndWait()`. Existing tests and the adapter continue using `startTurn()` until Task 3, which keeps the Wave 0 commit type-correct.

Use this pattern for the new test:

```ts
const started = client.startTurnAndWait("thread-1", "continue");
const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
respond(process, { id, result: turnStartResult("turn-1", "completed") });
await expect(started).resolves.toEqual({ turnId: "turn-1", status: "completed" });
```

- [ ] **Step 6: Run the protocol tests**

Run:

```powershell
npm.cmd test -- codex-app-server.test.ts
npm.cmd run lint
```

Expected: both commands pass.

- [ ] **Step 7: Commit the frozen interface**

```powershell
git add src/notify/codex-app-server.ts src/notify/types.ts test/unit/notify/codex-app-server.test.ts
git commit -m "feat(notify): define callback turn lifecycle contract"
```

---

### Task 2: Wait for `turn/completed` without model polling

**Files:**
- Modify: `src/notify/codex-app-server.ts:58-370`
- Test: `test/unit/notify/codex-app-server.test.ts`

**Interfaces:**
- Consumes: Task 1 `startTurnAndWait()` and `CodexTurnCompletion`.
- Produces: event-driven completion, five-minute internal timeout, abort handling, and bounded cleanup.

- [ ] **Step 1: Make the test client options injectable and add lifecycle-notification tests before implementation**

Import the options type and generalize the helper without changing existing callers:

```ts
import {
  CodexAppServerError,
  createCodexAppServerClient,
  type CodexAppServerClientOptions
} from "../../../src/notify/codex-app-server.js";

async function initializeClient(
  process: FakeAppServerProcess,
  options: CodexAppServerClientOptions = {}
) {
  const client = createCodexAppServerClient(options);
}
```

Change only the helper signature and `createCodexAppServerClient(options)` line shown above; leave its existing initialize request, response, and assertion body unchanged.

Add the following helper and tests:

```ts
function completeTurn(
  process: FakeAppServerProcess,
  threadId: string,
  turnId: string,
  status: "completed" | "interrupted" | "failed"
): void {
  respond(process, {
    method: "turn/completed",
    params: {
      threadId,
      turn: { id: turnId, status, items: [] }
    }
  });
}

it("waits for the matching turn/completed notification", async () => {
  const client = await initializeClient(process);
  const completion = client.startTurnAndWait("thread-1", "continue");
  const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
  respond(process, { id, result: turnStartResult("turn-1") });

  let settled = false;
  void completion.finally(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);

  completeTurn(process, "thread-other", "turn-1", "completed");
  completeTurn(process, "thread-1", "turn-other", "completed");
  await Promise.resolve();
  expect(settled).toBe(false);

  completeTurn(process, "thread-1", "turn-1", "completed");
  await expect(completion).resolves.toEqual({ turnId: "turn-1", status: "completed" });
  await client.close();
});

it.each(["interrupted", "failed"] as const)(
  "returns terminal callback status %s",
  async (status) => {
    const client = await initializeClient(process);
    const completion = client.startTurnAndWait("thread-1", "continue");
    const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
    respond(process, { id, result: turnStartResult("turn-1") });
    completeTurn(process, "thread-1", "turn-1", status);
    await expect(completion).resolves.toEqual({ turnId: "turn-1", status });
    await client.close();
  }
);

it("consumes a completion that arrives before the turn/start response", async () => {
  const client = await initializeClient(process);
  const completion = client.startTurnAndWait("thread-1", "continue");
  const [{ id }] = messagesFrom(process) as Array<{ id: number }>;

  completeTurn(process, "thread-1", "turn-race", "completed");
  respond(process, { id, result: turnStartResult("turn-race") });

  await expect(completion).resolves.toEqual({
    turnId: "turn-race",
    status: "completed"
  });
  await client.close();
});
```

- [ ] **Step 2: Run the tests and verify the promise remains unresolved**

Run:

```powershell
npm.cmd test -- codex-app-server.test.ts
```

Expected: new completion tests time out or fail because notifications are ignored.

- [ ] **Step 3: Route only valid matching terminal notifications**

Change the notification branch in `handleLine()`:

```ts
if (!hasOwn(parsed, "id")) {
  if (!isNotification(parsed)) {
    this.failProtocol();
    return;
  }
  this.handleNotification(parsed);
  return;
}
```

Add:

```ts
private handleNotification(notification: Record<string, unknown>): void {
  if (notification.method !== "turn/completed") return;
  const completion = readTurnCompletedNotification(notification);
  if (!completion) {
    this.failProtocol();
    return;
  }
  const waiter = this.turnWaiters.get(completion.turnId);
  if (!waiter) {
    this.terminalTurns.set(completion.turnId, completion);
    return;
  }
  if (waiter.threadId !== completion.threadId) return;
  this.turnWaiters.delete(completion.turnId);
  waiter.resolve({ turnId: completion.turnId, status: completion.status });
}
```

Add the strict parser:

```ts
function readTurnCompletedNotification(value: Record<string, unknown>):
  | (CodexTurnCompletion & { threadId: string })
  | undefined {
  if (!isRecord(value.params) ||
      typeof value.params.threadId !== "string" ||
      !isRecord(value.params.turn) ||
      typeof value.params.turn.id !== "string" ||
      typeof value.params.turn.status !== "string" ||
      !isTerminalTurnStatus(value.params.turn.status)) {
    return undefined;
  }
  return {
    threadId: value.params.threadId,
    turnId: value.params.turn.id,
    status: value.params.turn.status
  };
}
```

- [ ] **Step 4: Add malformed-notification, five-minute budget, abort, and close tests**

Use injectable manual timeout callbacks so the tests do not sleep:

```ts
it("rejects a malformed turn/completed notification as incompatible", async () => {
  const client = await initializeClient(process);
  const completion = client.startTurnAndWait("thread-1", "continue");
  const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
  respond(process, { id, result: turnStartResult("turn-1") });
  respond(process, {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } }
  });
  await expect(completion).rejects.toMatchObject({
    code: "codex_app_server_incompatible"
  });
  await client.close();
});

it("times out an in-progress callback turn", async () => {
  let fireTimeout: (() => void) | undefined;
  const cancelTimeout = vi.fn();
  const client = await initializeClient(process, {
    turnCompletionTimeoutMs: 50,
    scheduleTurnCompletionTimeout: (callback) => {
      fireTimeout = callback;
      return "turn-timeout";
    },
    cancelTurnCompletionTimeout: cancelTimeout
  });
  const completion = client.startTurnAndWait("thread-1", "continue");
  const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
  respond(process, { id, result: turnStartResult("turn-1") });
  fireTimeout!();
  await expect(completion).rejects.toMatchObject({
    code: "codex_turn_timeout",
    message: "Codex callback turn timed out"
  });
  expect(cancelTimeout).toHaveBeenCalledWith("turn-timeout");
  await client.close();
});

it("rejects a pending completion when its abort signal fires", async () => {
  const controller = new AbortController();
  const client = await initializeClient(process);
  const completion = client.startTurnAndWait("thread-1", "continue", controller.signal);
  const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
  respond(process, { id, result: turnStartResult("turn-1") });
  controller.abort();
  await expect(completion).rejects.toMatchObject({
    code: "codex_app_server_unavailable"
  });
  await client.close();
});

it("rejects a pending completion when the client closes", async () => {
  const client = await initializeClient(process);
  const completion = client.startTurnAndWait("thread-1", "continue");
  const [{ id }] = messagesFrom(process) as Array<{ id: number }>;
  respond(process, { id, result: turnStartResult("turn-1") });
  await client.close();
  await expect(completion).rejects.toMatchObject({
    code: "codex_app_server_unavailable"
  });
});
```

Add an abort test requiring `codex_app_server_unavailable`, and a close test proving a pending waiter rejects rather than hanging.

- [ ] **Step 5: Implement timeout, abort, and waiter rejection**

Extend `CodexAppServerClientOptions`:

```ts
turnCompletionTimeoutMs?: number;
scheduleTurnCompletionTimeout?: (callback: () => void, delayMs: number) => unknown;
cancelTurnCompletionTimeout?: (timer: unknown) => void;
```

Use `DEFAULT_TURN_COMPLETION_TIMEOUT_MS = 300_000`. Store `cleanup` on each waiter, remove timer and abort listener on every resolution, and extend `failAll()`:

```ts
for (const [turnId, waiter] of this.turnWaiters) {
  waiter.cleanup();
  waiter.reject(this.terminalError);
  this.turnWaiters.delete(turnId);
}
this.terminalTurns.clear();
```

The timeout callback must call:

```ts
this.failAll(new CodexAppServerError(
  "codex_turn_timeout",
  "Codex callback turn timed out"
));
this.observeTeardown();
```

- [ ] **Step 6: Verify lifecycle, malformed-frame, timeout, and cleanup cases**

Run:

```powershell
npm.cmd test -- codex-app-server.test.ts
npm.cmd run lint
```

Expected: pass with no unhandled rejection or fake-timer leak.

- [ ] **Step 7: Commit event-driven waiting**

```powershell
git add src/notify/codex-app-server.ts test/unit/notify/codex-app-server.test.ts
git commit -m "fix(notify): await callback turn completion"
```

---

### Task 3: Make outbox delivery mean completed callback

**Files:**
- Modify: `src/notify/codex-adapter.ts:39-135`
- Modify: `src/notify/codex-app-server.ts:17-170`
- Test: `test/unit/notify/codex-adapter.test.ts`
- Test: `test/unit/notify/codex-app-server.test.ts`

**Interfaces:**
- Consumes: `startTurnAndWait()` returning `CodexTurnCompletion`.
- Produces: retryable `codex_turn_interrupted`, `codex_turn_failed`, and `codex_turn_timeout` delivery codes.

- [ ] **Step 1: Rewrite the fake client and add failing outcome tests**

Change the fake to expose:

```ts
startTurnAndWait: vi.fn(async () => ({
  turnId: "turn-1",
  status: "completed" as const
}))
```

Add:

```ts
it.each([
  ["interrupted", "codex_turn_interrupted", "Codex callback turn was interrupted"],
  ["failed", "codex_turn_failed", "Codex callback turn failed"]
] as const)("retries callback status %s", async (status, errorCode, error) => {
  const client = fakeClient();
  client.startTurnAndWait.mockResolvedValueOnce({ turnId: "turn-1", status });

  await expect(deliverCodexNotification(
    delivery,
    job,
    signal,
    preparedConnection(client)
  )).resolves.toEqual({ outcome: "retry", error, errorCode });
  expect(client.close).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the adapter tests and verify false delivered behavior**

```powershell
npm.cmd test -- codex-adapter.test.ts
```

Expected: failures because every resolved start is currently treated as delivered.

- [ ] **Step 3: Confirm the frozen safe persisted error codes**

Verify Task 1 registered exactly:

```ts
"codex_turn_interrupted",
"codex_turn_failed",
"codex_turn_timeout"
```

Do not rename or duplicate them in this task.

- [ ] **Step 4: Settle only completed turns**

Replace the start call and unconditional delivered return with:

```ts
const completion = await client.startTurnAndWait(
  delivery.target.threadId,
  buildCodexNotificationPrompt(delivery, job, signal),
  attemptSignal
);
if (completion.status === "interrupted") {
  return {
    outcome: "retry",
    error: "Codex callback turn was interrupted",
    errorCode: "codex_turn_interrupted"
  };
}
if (completion.status === "failed") {
  return {
    outcome: "retry",
    error: "Codex callback turn failed",
    errorCode: "codex_turn_failed"
  };
}
return { outcome: "delivered" };
```

Add all three codes to the retryable public-message switch and leave them out of the permanent-code set.

After the adapter and tests use `startTurnAndWait()`, remove the transitional `startTurn()` declaration and implementation from `CodexAppServerClient` / `StdioCodexAppServerClient`. Update every remaining fake client to expose only `startTurnAndWait()`.

In App Server tests that formerly called `startTurn()` only to inspect the outbound RPC, call `startTurnAndWait()`, respond with `turnStartResult("turn-1", "completed")`, and await `{ turnId: "turn-1", status: "completed" }` before closing.

- [ ] **Step 5: Prove the client stays open until completion settles**

Use a deferred promise in the test, call `deliverCodexNotification()`, assert `close` has not been called, resolve the completion, then assert delivered and one close.

- [ ] **Step 6: Run adapter and type checks**

```powershell
npm.cmd test -- codex-adapter.test.ts
npm.cmd run lint
```

Expected: pass.

- [ ] **Step 7: Commit truthful settlement**

```powershell
git add src/notify/codex-app-server.ts src/notify/codex-adapter.ts test/unit/notify/codex-adapter.test.ts test/unit/notify/codex-app-server.test.ts
git commit -m "fix(notify): settle only completed callback turns"
```

---

### Task 4: Prove durable lease renewal and zero-model waiting

**Files:**
- Test: `test/unit/notify/dispatcher.test.ts`
- Test: `test/unit/notify/outbox.test.ts`

**Interfaces:**
- Consumes: Task 3 retry results and existing `startLeaseHeartbeat()`.
- Produces: proof that long callback waiting stays system-owned and persists safe error codes.

- [ ] **Step 1: Extend the existing deferred-delivery lease regression instead of duplicating it**

In the existing test named `renews a deferred adapter lease so a second worker cannot duplicate delivery`, add these assertions immediately after `firstDeliver` is observed:

```ts
expect(readDeliveries(job.notificationOutboxFile)[0]).toMatchObject({
  status: "delivering",
  attempts: 1
});
expect(readDeliveries(job.notificationOutboxFile)[0].deliveredAt).toBeUndefined();
```

Inside the renewal loop, after every `await timers.fireNext()`, assert the record is still `delivering` with no `deliveredAt`. Keep the existing second-worker exclusion and final `deliveredAt: "2026-07-16T00:00:31.000Z"` assertions. This proves the heartbeat runs while settlement remains pending.

- [ ] **Step 2: Add retry round-trip tests for every new code**

In `outbox.test.ts`, use `it.each` over:

```ts
[
  "codex_turn_interrupted",
  "codex_turn_failed",
  "codex_turn_timeout"
] as const
```

For each code, use a fresh outbox and execute this exact round trip:

```ts
it.each([
  "codex_turn_interrupted",
  "codex_turn_failed",
  "codex_turn_timeout"
] as const)("persists retryable callback error code %s", async (errorCode) => {
  const file = tempOutbox();
  const { delivery } = await enqueueDelivery(file, {
    jobId: `implement-${errorCode}`,
    signalCursor: 1,
    target,
    createdAt: now
  });
  const claim = (await claimDueDelivery(file, new Date(now), 30_000))!;

  await retryDelivery(
    file,
    delivery.id,
    claim.attempts,
    new Date("2026-07-16T00:01:00.000Z"),
    "Safe callback failure",
    errorCode
  );

  expect(readDeliveries(file)[0]).toMatchObject({
    status: "pending",
    attempts: 1,
    nextAttemptAt: "2026-07-16T00:01:00.000Z",
    lastError: "Safe callback failure",
    lastErrorCode: errorCode
  });
});
```

- [ ] **Step 3: Run the focused tests**

```powershell
npm.cmd test -- dispatcher.test.ts
npm.cmd test -- outbox.test.ts
```

Expected: both tests pass after Task 1 has registered the error codes. Any lease assertion failure reveals an unexpected dispatcher regression and blocks this lane for design review.

- [ ] **Step 4: Keep the production heartbeat unchanged**

The existing `startLeaseHeartbeat()` already renews ownership independently of the delivery promise. This task adds regression coverage only. A failure here blocks the plan and must be returned to design review rather than patched speculatively inside the persistence lane.

- [ ] **Step 5: Add a zero-model orchestration assertion**

In the same existing lease test, retain `expect(firstDeliver).toHaveBeenCalledOnce()` after settlement. Then add a separate structural guard; `fs` and `path` are already imported in this test file:

```ts
const dispatcherSource = fs.readFileSync(
  path.resolve("src/notify/dispatcher.ts"),
  "utf8"
);
expect(dispatcherSource).not.toMatch(/mimo_(status|events|wait)/);
```

- [ ] **Step 6: Verify and commit**

```powershell
npm.cmd test -- dispatcher.test.ts
npm.cmd test -- outbox.test.ts
npm.cmd run lint
git add test/unit/notify/dispatcher.test.ts test/unit/notify/outbox.test.ts
git commit -m "test(notify): prove durable zero-poll callback waiting"
```

Expected: tests pass; `src/notify/dispatcher.ts` is absent from the commit.

---

### Task 5: Strengthen installed callback acceptance

**Files:**
- Modify: `test/smoke/local-codex-notification.test.ts`
- Test: `test/smoke/local-codex-notification.test.ts`

**Interfaces:**
- Consumes: completed callback semantics from Tasks 2–4.
- Produces: installed-package evidence that output reached the originating task and outbox settlement occurred after the callback turn.

- [ ] **Step 1: Extend the smoke marker with callback completion evidence**

Keep the existing `mimo_result` marker unchanged:

```ts
interface ResultMarker {
  source: "mimo_result";
  jobId: string;
  kind: "implement";
  status: "completed";
  resultType: "final";
  output: string;
}
```

Update the temporary `AGENTS.md` instructions to require exactly one `mimo_result` and explicitly prohibit `mimo_status`, `mimo_events`, and `mimo_wait`. Zero-model polling is independently enforced by the system-code tests and App Server RPC cardinality; do not add self-reported audit fields.

- [ ] **Step 2: Assert the real RPC cardinality**

Retain the existing expected records:

```ts
expect(appServerRecords.filter((record) => record.method === "initialize")).toHaveLength(2);
expect(appServerRecords.filter((record) => record.method === "thread/resume")).toHaveLength(2);
expect(appServerRecords.filter((record) => record.method === "turn/start")).toHaveLength(1);
```

Document in the assertion message that the resumes are launch preflight plus delivery preparation, not polling.

- [ ] **Step 3: Assert outbox settlement follows callback completion**

Import the system-side outbox reader and type:

```ts
import { readNotificationDeliveries } from "../../src/notify/dispatcher.js";
import type { NotificationDelivery } from "../../src/notify/types.js";
```

Add this local-process helper; this polls a local JSONL file from Vitest and never starts or wakes a Codex model turn:

```ts
async function waitForTerminalDelivery(
  cwd: string,
  jobId: string,
  timeoutMs: number
): Promise<NotificationDelivery> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const delivery = readNotificationDeliveries(cwd)
      .find((candidate) => candidate.jobId === jobId);
    if (delivery?.status === "delivered" || delivery?.status === "failed") return delivery;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for terminal notification delivery: ${jobId}`);
}
```

Immediately after validating the marker, settle and compare:

```ts
const markerWrittenAt = fs.statSync(markerFile).mtimeMs;
const finalDelivery = await waitForTerminalDelivery(workspace, receipt.jobId, 30_000);
expect(finalDelivery).toMatchObject({
  status: "delivered",
  attempts: 1
});
expect(finalDelivery.deliveredAt).toBeDefined();
expect(Date.parse(finalDelivery.deliveredAt!))
  .toBeGreaterThanOrEqual(markerWrittenAt - 1_000);
```

- [ ] **Step 4: Run deterministic ordinary tests first**

```powershell
npm.cmd test -- codex-app-server.test.ts
npm.cmd test -- codex-adapter.test.ts
npm.cmd test -- dispatcher.test.ts
```

Expected: pass without environment gates.

- [ ] **Step 5: Run the opt-in installed smoke from a dedicated idle Codex task**

```powershell
$env:RUN_LOCAL_CODEX_NOTIFY_SMOKE='1'
npm.cmd run test:smoke:codex-notify
```

Expected: pass with one callback `turn/start`, two non-polling resume probes, one `mimo_result` marker, and delivered settlement after marker creation. The ordinary structural test—not a self-reported smoke field—proves that system waiting contains no status/event/wait calls.

- [ ] **Step 6: Commit acceptance coverage**

```powershell
git add test/smoke/local-codex-notification.test.ts
git commit -m "test(notify): verify completed zero-poll callback"
```

---

### Task 6: Document the zero-model-poll contract

**Files:**
- Modify: `skills/mimocode/SKILL.md`
- Modify: `README.md`
- Modify: `doc/operations-guide.md`

**Interfaces:**
- Consumes: the approved lifecycle and token boundary.
- Produces: caller and operator guidance consistent with implementation.

- [ ] **Step 1: Update the skill callback path**

State explicitly:

```text
After launch, do not call mimo_status, mimo_events, or mimo_wait. The notify worker
uses system-level App Server RPC once, waits on turn/completed without model polling,
and starts one callback turn. That callback calls mimo_result once and continues the
original request. delivered means the callback turn completed, not merely accepted.
```

- [ ] **Step 2: Update README terminology**

Replace claims equating accepted notification with delivery. Add the three safe retryable codes and explain that a full job normally has two system resume probes: preflight and delivery preparation.

- [ ] **Step 3: Add operations diagnostics**

Add an operator table:

| Observation | Meaning | Action |
|-------------|---------|--------|
| `delivering` after `turn/start` | Callback model turn is still running; Node lease heartbeat owns the wait. | Do not poll from Codex. |
| `pending` + `codex_turn_interrupted` | Callback turn ended interrupted. | Allow durable retry. |
| `pending` + `codex_turn_failed` | Callback turn failed. | Allow durable retry; inspect only after repeated failure. |
| `pending` + `codex_turn_timeout` | Five-minute callback budget expired. | Check task/tool blockage before retry exhaustion. |
| `delivered` | Matching callback turn completed. | No manual status check required. |

- [ ] **Step 4: Verify docs contain no polling contradiction**

```powershell
rg -n "mimo_status|mimo_events|mimo_wait|delivered|turn/start|turn/completed" skills/mimocode/SKILL.md README.md doc/operations-guide.md
```

Expected: diagnostic references are qualified; normal callback instructions forbid polling.

- [ ] **Step 5: Commit documentation**

```powershell
git add skills/mimocode/SKILL.md README.md doc/operations-guide.md
git commit -m "docs(notify): define zero-model callback waiting"
```

---

### Task 7: Integrate, verify, build, and refresh the plugin

**Files:**
- Verify: all files changed by Tasks 1–6
- Build output: `dist/`
- Validate: `.codex-plugin/plugin.json`, `.mcp.json`, `skills/mimocode/SKILL.md`, built MCP entrypoint

**Interfaces:**
- Consumes: every preceding task.
- Produces: verified source, validated plugin package, refreshed local install, and manual incident regression evidence.

- [ ] **Step 1: Review merged ownership and diff scope**

```powershell
git status --short
git diff --stat HEAD~6..HEAD
git diff --check HEAD~6..HEAD
```

Expected: only planned callback, test, and documentation files changed; pre-existing untracked plan documents remain untouched.

- [ ] **Step 2: Run narrow notification tests**

```powershell
npm.cmd test -- codex-app-server.test.ts
npm.cmd test -- codex-adapter.test.ts
npm.cmd test -- dispatcher.test.ts
npm.cmd test -- outbox.test.ts
```

Expected: all pass.

- [ ] **Step 3: Run full static and unit verification**

```powershell
npm.cmd run lint
npm.cmd test
npm.cmd run build
npm.cmd run validate:plugin
```

Expected: all commands exit 0.

- [ ] **Step 4: Create a new immutable plugin version**

Keep the following variables in one PowerShell session through Step 7:

```powershell
$newVersion = "0.1.0+codex.$(Get-Date -Format 'yyyyMMddHHmmss')"
$cacheRoot = 'C:\Users\Administrator\.codex\plugins\cache\personal\codex-mimocode'
$cacheTarget = Join-Path $cacheRoot $newVersion
if (Test-Path -LiteralPath $cacheTarget) {
  throw "Cache target already exists: $cacheTarget"
}
$newVersion
$cacheTarget
```

Use `apply_patch` to change only the `version` field in `.codex-plugin/plugin.json` to `$newVersion`, preserving every other byte-level field and formatting choice.

- [ ] **Step 5: Rebuild after the version change and create the cache snapshot**

```powershell
npm.cmd run build
npm.cmd run validate:plugin
New-Item -ItemType Directory -Path $cacheTarget | Out-Null
$packageItems = @(
  '.codex-plugin',
  '.mcp.json',
  'dist',
  'node_modules',
  'skills',
  'templates',
  'scripts',
  'hosts',
  'doc',
  'README.md',
  'package.json',
  'package-lock.json'
)
foreach ($item in $packageItems) {
  Copy-Item -LiteralPath (Join-Path (Get-Location) $item) -Destination $cacheTarget -Recurse
}
```

Expected: no existing cache directory is overwritten; `.git`, `.codex-mimo`, coverage, tests, temp files, and unrelated local plans are not copied.

- [ ] **Step 6: Validate the installed cache and compare critical hashes**

```powershell
Push-Location $cacheTarget
npm.cmd run validate:plugin
Pop-Location
$criticalFiles = @(
  '.codex-plugin\plugin.json',
  '.mcp.json',
  'dist\notify\codex-app-server.js',
  'dist\notify\codex-adapter.js',
  'dist\notify\types.js',
  'dist\notify\dispatcher.js',
  'skills\mimocode\SKILL.md'
)
foreach ($file in $criticalFiles) {
  $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path (Get-Location) $file)).Hash
  $cacheHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $cacheTarget $file)).Hash
  if ($sourceHash -ne $cacheHash) { throw "Hash mismatch: $file" }
}
```

Expected: installed validation passes and every critical hash matches.

- [ ] **Step 7: Commit the immutable release version**

```powershell
git add .codex-plugin/plugin.json
git commit -m "chore(plugin): refresh release version"
```

- [ ] **Step 8: Restart Codex Desktop and run installed smoke**

From a dedicated idle task with the required environment:

```powershell
$env:RUN_LOCAL_CODEX_NOTIFY_SMOKE='1'
$env:CODEX_MIMO_INSTALLED_PLUGIN_ROOT=$cacheTarget
npm.cmd run test:smoke:codex-notify
```

Expected: one successful callback turn and delivered outbox record.

- [ ] **Step 9: Reproduce the original Compose scenario**

Launch one read-only Compose `plan` job with an explicit Codex target, return the queued receipt, and stop. Do not send a manual follow-up. Acceptance requires automatic non-empty writeback, one callback `turn/start`, no waiting-stage MiMo status tools, and no empty interrupted turn.

- [ ] **Step 10: Record final verification without changing runtime artifacts**

Report command results, installed plugin version/path, callback job id, notification attempts, callback turn terminal status, and whether the opt-in smoke ran. Do not commit `.codex-mimo/`, temp smoke workspaces, plugin cache files, or Codex session logs.

## Cursor Parallel Execution Instruction

Paste this single sentence into Cursor after opening the repository:

```text
请使用 codex-mimocode 的 Compose parallel 工作流，严格按 docs/superpowers/plans/2026-07-23-codex-callback-turn-lifecycle.md 的 Wave 0–4 和文件所有权并行实施；先完成并合并 Task 1 冻结接口，再并行推进各 lane，每个 Task 坚持 TDD、独立提交和复核，等待阶段严禁调用 mimo_status、mimo_events 或 mimo_wait，最终统一执行 Task 7 的全量验证、插件刷新与真实回调验收。
```

## Completion Checklist

- [ ] `startTurnAndWait()` waits on matching `turn/completed`.
- [ ] Exactly one callback `turn/start` occurs per successful attempt.
- [ ] End-to-end audit shows two one-time resumes: preflight and delivery preparation.
- [ ] No resume, start, or MiMo status/event/wait polling occurs during completion waiting.
- [ ] Interrupted, failed, and timed-out callbacks never become delivered.
- [ ] Outbox lease renews while the callback runs.
- [ ] `deliveredAt` is written only after callback completion.
- [ ] Callback calls `mimo_result` once and writes a non-empty final answer.
- [ ] Focused tests, full tests, lint, build, and plugin validation pass.
- [ ] Installed smoke and manual Compose regression pass.
- [ ] Existing unrelated untracked documents remain untouched.
