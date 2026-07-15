# Unified Background Jobs and Active Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert all six MiMoCode work entry points to one persisted background-job runtime and deliver only attention events through a durable webhook or Codex Desktop notification adapter, eliminating default `mimo_wait` polling.

**Architecture:** MCP and CLI work commands call one `JobLauncher`; a registry supplies the six job-specific prompts, arguments, write policy, and finalization rules to one `JobWorker`. All state changes pass through `transitionJob()`, which writes signals and idempotent outbox deliveries; a separate notification worker leases deliveries and dispatches them through webhook or Codex App Server adapters without changing job outcomes.

**Tech Stack:** TypeScript 5.7, Node.js 22 ESM/NodeNext, Zod 3, MCP SDK 1.29, Execa 9, Vitest 2, newline-delimited JSON, filesystem leases, Node `http`/`https`/`crypto`/`child_process`.

## Global Constraints

- Treat `docs/superpowers/specs/2026-07-16-background-job-notification-design.md` as the approved source of truth.
- Do not preserve synchronous work-tool responses, foreground Compose, heartbeat/wake, `mimo_resume_job`, deprecated aliases, or compatibility shims.
- Keep exactly these 13 MCP tools: `mimo_healthcheck`, `mimo_plan`, `mimo_implement`, `mimo_review`, `mimo_fix_ci`, `mimo_resume`, `mimo_compose`, `mimo_status`, `mimo_events`, `mimo_wait`, `mimo_result`, `mimo_cancel`, `mimo_jobs`.
- Keep `stdin: "ignore"` for every `mimo run --format json` process and use UTF-8 process environments on Windows.
- Persist only the webhook secret environment-variable name; never persist, log, signal, report, or return the secret value.
- Emit caller notifications only for `needs_input`, `blocked`, `completed`, `failed`, `cancelled`, and `timeout`; ordinary milestones remain readable only through `mimo_events`.
- Use the fixed retry sequence: immediate, 10 seconds, 1 minute, 5 minutes, then every 5 minutes, stopping 30 minutes after the delivery was created.
- A failed caller notification never changes job status; a missing or unsuccessful internal `session.post` execution callback does.
- Use `.js` extensions in TypeScript imports and `apply_patch` for file edits and deletions.
- Preserve the unrelated untracked `.mimocode/.cron-lock` file.

## File Responsibility Map

### Create

- `src/core/job-transition.ts` — legal status graph, the only status mutation API, signal creation, and attention-delivery enqueueing.
- `src/core/job-outcome.ts` — centralized precedence rules for `needs_input`, `blocked`, terminal failures, and completion.
- `src/core/job-definitions.ts` — typed requests and the six-entry `JobDefinitionRegistry`; no process lifecycle code.
- `src/core/job-launcher.ts` — request validation, target freezing, job persistence, detached worker start, and uniform receipt.
- `src/core/job-worker.ts` — one execution lifecycle for all job kinds.
- `src/mimo/streaming-runner.ts` — generic streamed `mimo run` process runner moved out of Compose.
- `src/notify/types.ts` — delivery, payload, adapter, retry, and lease contracts.
- `src/notify/target.ts` — explicit target/environment resolution and webhook URL validation.
- `src/notify/outbox.ts` — append-only JSONL delivery journal, idempotency, lock, lease, and recovery.
- `src/notify/webhook-adapter.ts` — compact signed POST delivery and HTTP error classification.
- `src/notify/codex-app-server.ts` — JSON-RPC transport for Codex App Server.
- `src/notify/codex-adapter.ts` — resume-idle-thread/start-turn notification behavior and compact prompt.
- `src/notify/dispatcher.ts` — adapter routing, retry schedule, and delivery state updates.
- `src/notify/worker.ts` — workspace notification-worker loop.
- `test/integration/unified-background-jobs.test.ts` — fake MiMo/hook/caller end-to-end matrix.
- `test/smoke/local-codex-notification.test.ts` — explicitly gated real Codex callback smoke.

### Modify

- `src/core/jobs.ts`, `job-store.ts`, `job-signals.ts`, `job-log.ts`, `job-render.ts`, `job-process.ts` — unified domain, storage paths, attention filtering, receipts/results, and worker process launch.
- `src/mimo/hook-callback.ts`, `run-json.ts`, `prompt-transport.ts` — rename execution-callback types and retain generic MiMo argument/prompt transport.
- `src/compose/events.ts`, `post-checks.ts`, `report.ts`, `verify.ts`, `workflow.ts` — remain Compose/domain helpers consumed by job definitions.
- `src/codex/tool-names.ts`, `tool-schemas.ts`, `tools.ts`, `mcp-server.ts` — new 13-tool surface and launcher/control handlers.
- `src/cli/main.ts`, `commands.ts`, `hints.ts` — launcher-backed work commands and control commands.
- `scripts/validate-plugin.mjs`, `skills/mimocode/SKILL.md`, `README.md`, `doc/operations-guide.md`, `doc/compose-workflows.md` — new public contract and no-poll guidance.
- Existing unit tests under `test/unit/core`, `test/unit/mcp-tools`, `test/unit/compose`, `test/unit/cli.test.ts`, `test/unit/tool-schemas.test.ts`, and plugin tests — replace old contracts with the unified model.

### Delete After References Are Migrated

- `src/codex/wake.ts`, `src/codex/compact.ts`
- `src/core/job-runtime.ts`, `src/core/job-phase.ts`, `src/core/sessions.ts`
- `src/mimo/mimo-runner.ts`
- `src/compose/job-worker.ts`, `src/compose/runner.ts`, `src/compose/streaming-runner.ts`
- Old wake, compact, direct-runner, session-store, foreground/background Compose, and `mimo_resume_job` tests whose behavior is replaced below.

The notification subsystem and job runtime cannot be released independently: a terminal transition needs a durable delivery before the old wait/wake path can be removed. Keep this as one atomic migration, but use the commits below as review gates.

---

### Task 1: Unified Job Domain, Stored Target, and Path Contract

**Files:**
- Create: `src/notify/types.ts`
- Create: `src/notify/target.ts`
- Modify: `src/core/jobs.ts`
- Modify: `src/core/job-store.ts`
- Test: `test/unit/notify/target.test.ts`
- Test: `test/unit/job-store.test.ts`
- Test: `test/unit/jobs.test.ts`

**Interfaces:**
- Produces: `NotificationTarget`, `NotificationInput`, `resolveNotificationTarget(input, env)`, the eight-value `JobStatus`, active-only `JobPhase`, `ExecutionCallbackSummary`, `JobReceipt`, and `JobRecord.notificationOutboxFile`.
- Consumes: existing `buildJobId()`, `preparePromptTransport()`, and atomic job-record write behavior.

- [ ] **Step 1: Add failing target and persistence tests**

```ts
import { describe, expect, it } from "vitest";
import { resolveNotificationTarget } from "../../../src/notify/target.js";

describe("resolveNotificationTarget", () => {
  it("freezes explicit targets before CODEX_THREAD_ID", () => {
    expect(resolveNotificationTarget({ type: "codex", threadId: "explicit" }, { CODEX_THREAD_ID: "ambient" }))
      .toEqual({ type: "codex", threadId: "explicit" });
    expect(resolveNotificationTarget({ type: "webhook", url: "https://example.test/hook", secretEnv: "HOOK_SECRET" }, {}))
      .toEqual({ type: "webhook", url: "https://example.test/hook", secretEnv: "HOOK_SECRET" });
  });

  it("uses ambient Codex thread only when notify is omitted", () => {
    expect(resolveNotificationTarget(undefined, { CODEX_THREAD_ID: "thread-1" }))
      .toEqual({ type: "codex", threadId: "thread-1" });
    expect(resolveNotificationTarget(undefined, {})).toBeUndefined();
  });

  it.each(["file:///tmp/hook", "ftp://example.test/hook", "not-a-url"])("rejects webhook URL %s", (url) => {
    expect(() => resolveNotificationTarget({ type: "webhook", url, secretEnv: "HOOK_SECRET" }, {}))
      .toThrow("Webhook URL must use http or https");
  });

  it("rejects unresolved explicit Codex target", () => {
    expect(() => resolveNotificationTarget({ type: "codex" }, {})).toThrow("Codex notification requires threadId");
  });
});
```

Extend `test/unit/job-store.test.ts` to assert a created record has `status: "queued"`, no `phase`, the frozen target, and paths ending in `.events.jsonl`, `.signals.jsonl`, and the workspace `notifications.jsonl`.

- [ ] **Step 2: Run the narrow tests and confirm RED**

Run: `npm.cmd test -- test/unit/notify/target.test.ts test/unit/job-store.test.ts test/unit/jobs.test.ts`

Expected: FAIL because `src/notify/target.ts` is absent and the old job types reject suspended/timeout states.

- [ ] **Step 3: Replace the public domain types and target resolver**

Implement these exact public contracts:

```ts
export type NotificationInput =
  | { type: "codex"; threadId?: string }
  | { type: "webhook"; url: string; secretEnv: string };

export type NotificationTarget =
  | { type: "codex"; threadId: string }
  | { type: "webhook"; url: string; secretEnv: string };

export type JobStatus =
  | "queued" | "running" | "needs_input" | "blocked"
  | "completed" | "failed" | "cancelled" | "timeout";

export type JobPhase =
  | "starting" | "planning" | "investigating" | "editing"
  | "verifying" | "reviewing" | "finalizing";

export type JobKind = "plan" | "implement" | "review" | "fix-ci" | "resume" | "compose";

export interface JobReceipt {
  jobId: string;
  kind: JobKind;
  status: "queued";
  actions: {
    status: "mimo_status";
    events: "mimo_events";
    result: "mimo_result";
    cancel: "mimo_cancel";
  };
}
```

`resolveNotificationTarget()` trims strings, validates `http:`/`https:`, requires a non-empty `secretEnv`, and returns a newly allocated target so later environment mutation cannot affect the record. Rename `JobCallbackSummary`/`callback` to `ExecutionCallbackSummary`/`executionCallback`. Make `phase?: JobPhase`, add `notificationTarget?: NotificationTarget` and `notificationOutboxFile: string`, and remove wake/resume hints.

- [ ] **Step 4: Update storage without compatibility fallbacks**

`resolveJobPaths()` returns:

```ts
return {
  jobFile: path.join(jobDir, `${jobId}.json`),
  logFile: path.join(jobDir, `${jobId}.log`),
  eventsFile: path.join(jobDir, `${jobId}.events.jsonl`),
  signalsFile: path.join(jobDir, `${jobId}.signals.jsonl`),
  notificationOutboxFile: path.join(jobDir, "notifications.jsonl")
};
```

`CreateJobInput` accepts `notificationTarget?: NotificationTarget`; the created record stores it and has no `phase`. Remove `workflow` as a top-level special case; it remains inside `request`. Remove record-read fallbacks for legacy fields because historical compatibility was explicitly rejected.

- [ ] **Step 5: Run tests and commit**

Run: `npm.cmd test -- test/unit/notify/target.test.ts test/unit/job-store.test.ts test/unit/jobs.test.ts`

Expected: PASS.

```powershell
git add src/core/jobs.ts src/core/job-store.ts src/notify/types.ts src/notify/target.ts test/unit/notify/target.test.ts test/unit/job-store.test.ts test/unit/jobs.test.ts
git commit -m "refactor: define unified background job domain"
```

### Task 2: Durable Notification Outbox with Idempotency and Leases

**Files:**
- Modify: `src/notify/types.ts`
- Create: `src/notify/outbox.ts`
- Test: `test/unit/notify/outbox.test.ts`
- Test: `test/unit/cross-cutting/concurrent-access.test.ts`

**Interfaces:**
- Consumes: `NotificationTarget`, workspace outbox path from Task 1.
- Produces: `enqueueDelivery()`, `readDeliveries()`, `claimDueDelivery()`, `completeDelivery()`, `retryDelivery()`, and `failDelivery()`.

- [ ] **Step 1: Write the failing journal tests**

```ts
it("deduplicates job cursor and target kind", () => {
  const first = enqueueDelivery(file, { jobId: "implement-1", signalCursor: 3, target, createdAt: now });
  const second = enqueueDelivery(file, { jobId: "implement-1", signalCursor: 3, target, createdAt: now });
  expect(second.id).toBe(first.id);
  expect(readDeliveries(file)).toHaveLength(1);
});

it("recovers an expired delivering lease", () => {
  enqueueDelivery(file, { jobId: "plan-1", signalCursor: 1, target, createdAt: "2026-07-16T00:00:00.000Z" });
  const first = claimDueDelivery(file, new Date("2026-07-16T00:00:00.000Z"), 30_000)!;
  expect(claimDueDelivery(file, new Date("2026-07-16T00:00:10.000Z"), 30_000)).toBeUndefined();
  expect(claimDueDelivery(file, new Date("2026-07-16T00:00:31.000Z"), 30_000)?.id).toBe(first.id);
});
```

Add a concurrent-access test that starts two `claimDueDelivery()` calls and proves only one receives the same delivery.

- [ ] **Step 2: Run the outbox tests and confirm RED**

Run: `npm.cmd test -- test/unit/notify/outbox.test.ts test/unit/cross-cutting/concurrent-access.test.ts`

Expected: FAIL because the outbox API does not exist.

- [ ] **Step 3: Implement the append-only delivery journal**

Use this contract:

```ts
export type DeliveryStatus = "pending" | "delivering" | "delivered" | "failed";

export interface NotificationDelivery {
  id: string;
  eventId: string;
  jobId: string;
  signalCursor: number;
  target: NotificationTarget;
  status: DeliveryStatus;
  attempts: number;
  createdAt: string;
  nextAttemptAt?: string;
  leaseUntil?: string;
  deliveredAt?: string;
  lastError?: string;
}
```

Each mutation appends a complete delivery snapshot. `readDeliveries()` parses valid lines and keeps the last snapshot per `id`. Derive `eventId` and `id` as `${jobId}:${signalCursor}:${target.type}`. Protect read-modify-append with an adjacent `notifications.lock` opened using `fs.openSync(lock, "wx")`; retry lock acquisition for at most 2 seconds with a synchronous 10 ms wait and always remove the lock in `finally`. `claimDueDelivery()` may reclaim `delivering` only when `leaseUntil <= now`.

- [ ] **Step 4: Run tests and commit**

Run: `npm.cmd test -- test/unit/notify/outbox.test.ts test/unit/cross-cutting/concurrent-access.test.ts`

Expected: PASS with one lease holder and one logical delivery after journal replay.

```powershell
git add src/notify/types.ts src/notify/outbox.ts test/unit/notify/outbox.test.ts test/unit/cross-cutting/concurrent-access.test.ts
git commit -m "feat: add durable notification outbox"
```

### Task 3: Single State Transition API and Central Outcome Classification

**Files:**
- Create: `src/core/job-transition.ts`
- Create: `src/core/job-outcome.ts`
- Modify: `src/core/job-signals.ts`
- Modify: `src/core/job-store.ts`
- Test: `test/unit/core/job-transition.test.ts`
- Test: `test/unit/core/job-outcome.test.ts`
- Test: `test/unit/job-signals.test.ts`

**Interfaces:**
- Consumes: `enqueueDelivery()` from Task 2 and `updateJob()` from Task 1.
- Produces: `transitionJob(cwd, jobId, transition)`, `appendJobProgress()`, `isAttentionSignal()`, and `classifyRunOutcome(evidence)`.

- [ ] **Step 1: Write failing transition and precedence tests**

```ts
it.each([
  ["queued", "running"], ["queued", "failed"], ["running", "needs_input"], ["running", "blocked"],
  ["running", "completed"], ["running", "failed"], ["running", "cancelled"],
  ["running", "timeout"]
] as const)("allows %s -> %s", (from, to) => {
  seedJob({ status: from });
  expect(transitionJob(cwd, jobId, { status: to, summary: to }).job.status).toBe(to);
});

it("rejects terminal to running", () => {
  seedJob({ status: "completed" });
  expect(() => transitionJob(cwd, jobId, { status: "running", summary: "again" }))
    .toThrow("Illegal job transition completed -> running");
});

it("does not enqueue progress but enqueues one terminal event", () => {
  appendJobProgress(cwd, jobId, { kind: "milestone", level: "info", summary: "read files" });
  expect(readDeliveries(outbox)).toEqual([]);
  transitionJob(cwd, jobId, { status: "completed", summary: "done" });
  expect(readDeliveries(outbox)).toHaveLength(1);
});
```

Outcome cases must assert this precedence: user cancellation, timeout, missing/error/cancelled execution callback, explicit needs-input text, explicit blocked text, failed verification/nonzero exit, completion.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm.cmd test -- test/unit/core/job-transition.test.ts test/unit/core/job-outcome.test.ts test/unit/job-signals.test.ts`

Expected: FAIL because transitions and classifier are absent.

- [ ] **Step 3: Implement legal transitions and attention filtering**

```ts
const LEGAL: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["needs_input", "blocked", "completed", "failed", "cancelled", "timeout"],
  needs_input: [], blocked: [], completed: [], failed: [], cancelled: [], timeout: []
};

export const ATTENTION_SIGNAL_KINDS = [
  "needs_input", "blocked", "completed", "failed", "cancelled", "timeout"
] as const;
```

`transitionJob()` validates the graph, sets `phase` only for `running`, clears `pid` and `phase` for every other destination, writes exactly one status signal, and calls `enqueueDelivery()` only when the job has a frozen target and the signal is an attention kind. Return `{ job, signal, deliveryCreated }` so callers know when to start the notification worker. `appendJobProgress()` accepts only non-attention signal kinds and never mutates status.

- [ ] **Step 4: Implement one outcome classifier**

```ts
export interface RunEvidence {
  exitCode: number;
  terminationReason?: "process_timeout" | "host_abort" | "user_cancelled";
  executionCallback?: ExecutionCallbackSummary;
  verification: JobVerification[];
  finalText: string;
}

export interface JobOutcome {
  status: Exclude<JobStatus, "queued" | "running">;
  summary: string;
  sessionId?: string | null;
  changedFiles?: string[];
  verification?: JobVerification[];
  executionCallback?: ExecutionCallbackSummary;
  reportPaths?: JobReportPaths;
  error?: string;
  errorCode?: string;
}
```

Use anchored, case-insensitive patterns for explicit requests (`need ... input`, `please provide/clarify`, a final question requesting required information) and blockers (`blocked`, `cannot continue/proceed`, missing permission/dependency/external service). Do not classify ordinary reasoning questions. Map missing callback to `callback_missing`, callback error to `callback_error`, callback cancellation to `callback_cancelled`, timeout to `timeout`, failed verification to `verification_failed`, and nonzero exit to `mimo_exit_nonzero`.

- [ ] **Step 5: Run tests and commit**

Run: `npm.cmd test -- test/unit/core/job-transition.test.ts test/unit/core/job-outcome.test.ts test/unit/job-signals.test.ts`

Expected: PASS.

```powershell
git add src/core/job-transition.ts src/core/job-outcome.ts src/core/job-signals.ts src/core/job-store.ts test/unit/core/job-transition.test.ts test/unit/core/job-outcome.test.ts test/unit/job-signals.test.ts
git commit -m "feat: centralize job transitions and outcomes"
```

### Task 4: Signed Webhook Adapter

**Files:**
- Modify: `src/notify/types.ts`
- Create: `src/notify/webhook-adapter.ts`
- Test: `test/unit/notify/webhook-adapter.test.ts`

**Interfaces:**
- Consumes: terminal `JobRecord`, `JobSignal`, and webhook `NotificationDelivery`.
- Produces: `buildNotificationPayload()`, `signWebhookBody()`, and `deliverWebhook()` returning `DeliveryAttemptResult`.

- [ ] **Step 1: Write failing payload, signing, and response-classification tests**

```ts
it("signs exactly the compact serialized body", async () => {
  const fetch = vi.fn(async (_url, init) => ({ status: 204, ok: true } as Response));
  const result = await deliverWebhook(delivery, job, signal, { HOOK_SECRET: "secret" }, fetch);
  const init = fetch.mock.calls[0][1]!;
  const body = String(init.body);
  expect(init.headers).toMatchObject({
    "X-Codex-Mimo-Event-Id": delivery.eventId,
    "X-Codex-Mimo-Signature": createHmac("sha256", "secret").update(body).digest("hex")
  });
  expect(body).not.toContain("secret");
  expect(result).toEqual({ outcome: "delivered" });
});

it.each([[408, "retry"], [429, "retry"], [500, "retry"], [404, "permanent"]] as const)
  ("classifies HTTP %s as %s", async (status, outcome) => {
    const fetch = vi.fn(async () => ({ status, ok: false } as Response));
    expect((await deliverWebhook(delivery, job, signal, { HOOK_SECRET: "secret" }, fetch)).outcome)
      .toBe(outcome);
  });
```

Also assert missing/empty `HOOK_SECRET` is permanent and that payload keys are exactly `version`, `eventId`, `event`, `createdAt`, `job`, and `result`.

- [ ] **Step 2: Run test and confirm RED**

Run: `npm.cmd test -- test/unit/notify/webhook-adapter.test.ts`

Expected: FAIL because the adapter is absent.

- [ ] **Step 3: Implement the adapter**

```ts
export type DeliveryAttemptResult =
  | { outcome: "delivered" }
  | { outcome: "retry"; error: string }
  | { outcome: "permanent"; error: string };
```

Build version-1 payloads only from compact job/result fields. Use `JSON.stringify(payload)` once, sign those exact UTF-8 bytes with `createHmac("sha256", secret).update(body).digest("hex")`, and POST with `content-type: application/json`, `X-Codex-Mimo-Event-Id`, and `X-Codex-Mimo-Signature`. Treat fetch exceptions, 408, 429, and 5xx as retryable; other non-2xx responses as permanent.

- [ ] **Step 4: Run tests and commit**

Run: `npm.cmd test -- test/unit/notify/webhook-adapter.test.ts`

Expected: PASS.

```powershell
git add src/notify/types.ts src/notify/webhook-adapter.ts test/unit/notify/webhook-adapter.test.ts
git commit -m "feat: deliver signed webhook notifications"
```

### Task 5: Codex App Server Transport and Adapter

Protocol reference: [official Codex App Server documentation](https://developers.openai.com/codex/app-server). It confirms the stdio JSONL transport, omitted `jsonrpc` header, mandatory `initialize`/`initialized` handshake, version-matched schema generation, `thread/resume`, and `turn/start` input shape used below.

**Files:**
- Create: `src/notify/codex-app-server.ts`
- Create: `src/notify/codex-adapter.ts`
- Test: `test/unit/notify/codex-app-server.test.ts`
- Test: `test/unit/notify/codex-adapter.test.ts`

**Interfaces:**
- Consumes: Codex `NotificationDelivery`, job and signal.
- Produces: `CodexAppServerClient`, `createCodexAppServerClient()`, `buildCodexNotificationPrompt()`, and `deliverCodexNotification()`.

- [ ] **Step 1: Write failing protocol-order and prompt tests**

```ts
it("resumes an idle thread and starts exactly one new turn", async () => {
  const calls: string[] = [];
  const client: CodexAppServerClient = {
    initialize: async () => { calls.push("initialize"); },
    resumeThread: async (threadId) => { calls.push(`resume:${threadId}`); return { exists: true, busy: false }; },
    startTurn: async (threadId, prompt) => { calls.push(`turn:${threadId}:${prompt}`); },
    close: async () => { calls.push("close"); }
  };
  expect(await deliverCodexNotification(delivery, job, signal, client)).toEqual({ outcome: "delivered" });
  expect(calls).toEqual([
    "initialize",
    "resume:thread-1",
    "turn:thread-1:MiMoCode job implement-1 emitted completed. Call mimo_result and continue handling the original request.",
    "close"
  ]);
});

it("returns retry while the original turn is active", async () => {
  const client = fakeClient({ exists: true, busy: true });
  expect((await deliverCodexNotification(delivery, job, signal, client)).outcome).toBe("retry");
  expect(client.startTurn).not.toHaveBeenCalled();
});
```

Assert `needs_input` and `blocked` append one sanitized reason line capped at 240 characters; missing/forbidden threads are permanent; transport start/connect errors retry.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm.cmd test -- test/unit/notify/codex-app-server.test.ts test/unit/notify/codex-adapter.test.ts`

Expected: FAIL because both modules are absent.

- [ ] **Step 3: Implement the transport boundary**

```ts
export interface ThreadResumeResult { exists: boolean; busy: boolean; }

export interface CodexAppServerClient {
  initialize(): Promise<void>;
  resumeThread(threadId: string): Promise<ThreadResumeResult>;
  startTurn(threadId: string, prompt: string): Promise<void>;
  close(): Promise<void>;
}
```

Before coding the transport, run `codex app-server generate-json-schema --out .codex-mimo/app-server-schema` and inspect the generated `ThreadResume` and `TurnStart` schemas for the installed Codex version; remove that temporary directory before committing. The production client spawns `codex app-server --listen stdio://` hidden, with UTF-8 env and piped stdin/stdout. Implement newline-delimited JSON-RPC messages with the `jsonrpc` header omitted, numeric IDs, a pending-request map, `initialize` with `{clientInfo:{name:"codex_mimo",title:"Codex MiMoCode Bridge",version:"0.1.0"}}`, then the `initialized` notification, `thread/resume` with `{threadId}`, idle-state decoding from the returned thread, and `turn/start` with `{threadId,input:[{type:"text",text:prompt}]}`. Keep version-specific wire parsing inside this file so the adapter remains testable. Never send `turn/steer`. Reject a pending request if the process exits or writes an RPC error.

- [ ] **Step 4: Implement the Codex adapter**

`buildCodexNotificationPrompt()` returns exactly:

```text
MiMoCode job <jobId> emitted <event>. Call mimo_result and continue handling the original request.
```

For `needs_input`/`blocked`, append `Reason: <single compact line>`. `deliverCodexNotification()` initializes, resumes, returns retry while busy, returns permanent for missing/forbidden thread errors, calls `startTurn()` once for an idle thread, treats acceptance as delivered, and closes in `finally`.

- [ ] **Step 5: Run tests and commit**

Run: `npm.cmd test -- test/unit/notify/codex-app-server.test.ts test/unit/notify/codex-adapter.test.ts`

Expected: PASS and no `turn/steer` string in `src/notify`.

```powershell
git add src/notify/codex-app-server.ts src/notify/codex-adapter.ts test/unit/notify/codex-app-server.test.ts test/unit/notify/codex-adapter.test.ts
git commit -m "feat: notify original Codex thread"
```

### Task 6: Notification Dispatcher, Retry Schedule, and Worker Process

**Files:**
- Create: `src/notify/dispatcher.ts`
- Create: `src/notify/worker.ts`
- Modify: `src/core/job-process.ts`
- Test: `test/unit/notify/dispatcher.test.ts`
- Test: `test/unit/notify/worker.test.ts`
- Test: `test/unit/job-process.test.ts`

**Interfaces:**
- Consumes: outbox claim/update functions and both adapter results.
- Produces: `retryDelayMs(attempts)`, `dispatchNextDelivery(cwd, deps)`, `runNotificationWorker(cwd, deps)`, `summarizeJobNotification(job, deliveries)`, and `spawnNotificationWorker(cwd)`.

- [ ] **Step 1: Write failing retry and failure-isolation tests**

```ts
it.each([[1, 10_000], [2, 60_000], [3, 300_000], [4, 300_000], [9, 300_000]])
  ("uses fixed delay for attempt %s", (attempt, delay) => expect(retryDelayMs(attempt)).toBe(delay));

it("marks delivery failed after thirty minutes without changing the job", async () => {
  const before = readJob(cwd, jobId)!;
  await dispatchNextDelivery(cwd, { now: () => new Date("2026-07-16T00:31:00.000Z"), deliver: retryFailure });
  expect(readDeliveries(outbox)[0]).toMatchObject({ status: "failed", lastError: "offline" });
  expect(readJob(cwd, jobId)!.status).toBe(before.status);
});
```

Worker tests must prove an expired lease is reclaimed after restart and no secret value appears in job/log/outbox files.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm.cmd test -- test/unit/notify/dispatcher.test.ts test/unit/notify/worker.test.ts test/unit/job-process.test.ts`

Expected: FAIL because dispatcher/worker exports are absent and process launch only supports Compose.

- [ ] **Step 3: Implement dispatch and retry**

Route on `delivery.target.type`. Increment `attempts` when claiming. The first claim is the immediate attempt; after attempt 1, 2, and 3, schedule 10 seconds, 1 minute, and 5 minutes respectively, then keep the 5-minute interval. On delivery success append `delivered`; on permanent failure append `failed`; on retry compute `nextAttemptAt`. If `now - createdAt >= 1_800_000`, append `failed` instead of another retry. `runNotificationWorker()` loops while a due delivery exists, waits only until the nearest `nextAttemptAt`, and exits when no unfinished delivery remains. `summarizeJobNotification()` selects the latest delivery for a job and exposes only target type, delivery status, attempts, and last error.

- [ ] **Step 4: Generalize detached process launch**

Replace the Compose-only worker API with:

```ts
export type WorkerCommand = "job-worker" | "notify-worker";

export function spawnWorker(command: WorkerCommand, cwd: string, jobId?: string): number {
  const args = [resolveCliEntrypoint(), command, "--cwd", cwd];
  if (jobId) args.push("--job-id", jobId);
  const child = spawn(process.execPath, args, {
    cwd, detached: true, stdio: "ignore", windowsHide: true, env: withUtf8ProcessEnv()
  });
  child.unref();
  return child.pid ?? 0;
}
```

Expose thin `spawnJobWorker(cwd, jobId)` and `spawnNotificationWorker(cwd)` calls; there is no `compose-worker` branch.

- [ ] **Step 5: Run tests and commit**

Run: `npm.cmd test -- test/unit/notify/dispatcher.test.ts test/unit/notify/worker.test.ts test/unit/job-process.test.ts`

Expected: PASS.

```powershell
git add src/notify/dispatcher.ts src/notify/worker.ts src/core/job-process.ts test/unit/notify/dispatcher.test.ts test/unit/notify/worker.test.ts test/unit/job-process.test.ts
git commit -m "feat: dispatch caller notifications in background"
```

### Task 7: Generic Streaming Runner and Six Job Definitions

**Files:**
- Create: `src/mimo/streaming-runner.ts`
- Create: `src/core/job-definitions.ts`
- Modify: `src/mimo/hook-callback.ts`
- Modify: `src/compose/report.ts`
- Modify: `src/compose/events.ts`
- Modify: `src/compose/post-checks.ts`
- Modify: `src/compose/verify.ts`
- Modify: `src/compose/workflow.ts`
- Test: `test/unit/mimo-streaming-runner.test.ts`
- Test: `test/unit/core/job-definitions.test.ts`
- Test: existing focused Compose domain tests

**Interfaces:**
- Consumes: prompt builders, `buildMimoRunArgs()`, Compose workflow/report helpers, git snapshots, and `classifyRunOutcome()`.
- Produces: `runMimoCliStreaming()`, `JobDefinition<Kind, Request>`, `JobFinalizeContext<Request>`, typed `JOB_DEFINITIONS`, and `bindJobDefinition(job)`.

- [ ] **Step 1: Move runner tests first and add registry RED tests**

Move the behavior assertions from `test/unit/compose-streaming-runner.test.ts` to `test/unit/mimo-streaming-runner.test.ts`, changing only the import. Add:

```ts
it("registers exactly the six executable kinds", () => {
  expect(Object.keys(JOB_DEFINITIONS).sort()).toEqual(["compose", "fix-ci", "implement", "plan", "resume", "review"]);
});

it("resumes from the parent session", async () => {
  const definition = getJobDefinition("resume");
  const prompt = await definition.buildPrompt({ cwd, jobId: "parent-1", task: "continue", sessionId: "ses_1" });
  expect(definition.buildMimoArgs({ cwd, jobId: "parent-1", task: "continue", sessionId: "ses_1" }, prompt))
    .toContain("ses_1");
});
```

Add table cases for agent selection (`plan`/`review` use `plan`, write jobs use `build`, Compose uses `compose`), prompt transport, attachments, model/timeout, and Compose skill chain.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm.cmd test -- test/unit/mimo-streaming-runner.test.ts test/unit/core/job-definitions.test.ts`

Expected: FAIL because the generic paths are absent.

- [ ] **Step 3: Move the runner without behavior drift**

Copy the full process implementation into `src/mimo/streaming-runner.ts`, retain `stdio: ["ignore", "pipe", "pipe"]`, UTF-8 env, Windows `taskkill`, POSIX process-group termination, abort and timeout handling. Update Compose report's `TerminationReason` type import to the new module.

- [ ] **Step 4: Implement typed definitions**

```ts
export interface JobDefinition<Kind extends JobKind, Request extends { cwd: string }> {
  kind: Kind;
  writesAllowed: boolean;
  buildPrompt(request: Request): Promise<PromptTransportResult>;
  buildMimoArgs(request: Request, prompt: PromptTransportResult): string[];
  finalize(context: JobFinalizeContext<Request>): Promise<JobOutcome>;
}

export interface JobRequestByKind {
  plan: PlanJobRequest;
  implement: ImplementJobRequest;
  review: ReviewJobRequest;
  "fix-ci": FixCiJobRequest;
  resume: ResumeJobRequest;
  compose: ComposeJobRequest;
}

export type JobDefinitionRegistry = {
  [Kind in JobKind]: JobDefinition<Kind, JobRequestByKind[Kind]>;
};

export const JOB_DEFINITIONS: JobDefinitionRegistry = {
  plan: planDefinition,
  implement: implementDefinition,
  review: reviewDefinition,
  "fix-ci": fixCiDefinition,
  resume: resumeDefinition,
  compose: composeDefinition
};
```

`JobFinalizeContext` contains the stored job/request, streamed result, normalized events, `executionCallback`, git status/head before and after, diff/commit changes, and dependency-injected verification/report writers. `bindJobDefinition(job)` validates the stored request with the matching Zod schema once and returns bound zero-argument `buildPrompt()`, `buildMimoArgs(prompt)`, and `finalize(context)` methods, avoiding `any`, `never`, and repeated kind switches in the worker. Direct definitions return compact summary/changed files/verification; Compose alone calls workflow validation and writes Compose JSON/Markdown/event/diff reports. All definitions call the Task 3 classifier; none updates the job store.

Rename hook-facing stored terms to `executionCallback` while leaving the wire env/header names unchanged because they are internal protocol identifiers, not the caller notification API.

- [ ] **Step 5: Run domain tests and commit**

Run: `npm.cmd test -- test/unit/mimo-streaming-runner.test.ts test/unit/core/job-definitions.test.ts test/unit/compose`

Expected: PASS.

```powershell
git add src/mimo/streaming-runner.ts src/core/job-definitions.ts src/mimo/hook-callback.ts src/compose test/unit/mimo-streaming-runner.test.ts test/unit/core/job-definitions.test.ts test/unit/compose
git commit -m "refactor: define six generic MiMo jobs"
```

### Task 8: One Job Worker for Every Kind

**Files:**
- Create: `src/core/job-worker.ts`
- Modify: `src/core/job-log.ts`
- Modify: `src/core/job-transition.ts`
- Test: `test/unit/core/job-worker.test.ts`
- Test: `test/unit/cross-cutting/process-management.test.ts`
- Test: `test/unit/cross-cutting/error-propagation.test.ts`

**Interfaces:**
- Consumes: registry, streaming runner, execution callback, transitions, git helpers, and notification-worker spawn.
- Produces: `runJobWorker(cwd, jobId, deps?)`.

- [ ] **Step 1: Write failing table-driven lifecycle tests**

```ts
it.each(["plan", "implement", "review", "fix-ci", "resume", "compose"] as const)
  ("runs %s through the unified worker", async (kind) => {
    const job = seedQueuedJob(kind);
    await runJobWorker(cwd, job.id, completedDeps);
    expect(readJob(cwd, job.id)).toMatchObject({ status: "completed", pid: null });
    expect(completedDeps.runMimoStreaming).toHaveBeenCalledTimes(1);
  });
```

Add focused cases for hook missing/error/cancelled, timeout, user cancellation, startup exception, verification failure, `needs_input`, `blocked`, read-only write violation, PID clearing, raw-event persistence, and notification-worker start only when `deliveryCreated` is true.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm.cmd test -- test/unit/core/job-worker.test.ts test/unit/cross-cutting/process-management.test.ts test/unit/cross-cutting/error-propagation.test.ts`

Expected: FAIL because `runJobWorker()` is absent.

- [ ] **Step 3: Implement the single lifecycle**

`runJobWorker()` must perform this exact sequence:

```ts
const job = requireQueuedJob(cwd, jobId);
const definition = bindJobDefinition(job);
const running = transitionJob(cwd, jobId, { status: "running", phase: "starting", summary: "Starting MiMoCode." });
const prompt = await definition.buildPrompt();
const args = definition.buildMimoArgs(prompt);
const hook = await createHookCallbackController({ cwd, kind: job.kind });
const run = await runMimoCliStreaming(cwd, args, {
  timeoutMs: readTimeout(job.request), env: hook.env,
  onStart: (pid) => updateRunningJobPid(cwd, jobId, pid),
  onLine: (line) => appendRawAndNormalizedEvent(cwd, jobId, line)
});
const executionCallback = toExecutionCallback(hook.invocationId, await hook.waitForCallback());
const outcome = await definition.finalize(buildFinalizeContext(job, run, executionCallback));
const transitioned = transitionJob(cwd, jobId, outcome);
if (transitioned.deliveryCreated) spawnNotificationWorker(cwd);
```

Wrap setup/run/finalize in `try/catch/finally`; close the hook in `finally`. Convert process timeout to `timeout`, abort requested by `mimo_cancel` to `cancelled`, and unexpected exceptions to `failed`. Every status write, including catches, goes through `transitionJob()`. Direct PID updates may only occur while status is `running` and may not mutate status.

- [ ] **Step 4: Run tests and commit**

Run: `npm.cmd test -- test/unit/core/job-worker.test.ts test/unit/cross-cutting/process-management.test.ts test/unit/cross-cutting/error-propagation.test.ts`

Expected: PASS for all six kinds and failure paths.

```powershell
git add src/core/job-worker.ts src/core/job-log.ts src/core/job-transition.ts test/unit/core/job-worker.test.ts test/unit/cross-cutting/process-management.test.ts test/unit/cross-cutting/error-propagation.test.ts
git commit -m "feat: run all MiMo work in one worker"
```

### Task 9: Job Launcher and Background MCP Work Tools

**Files:**
- Create: `src/core/job-launcher.ts`
- Modify: `src/codex/tool-schemas.ts`
- Modify: `src/codex/tools.ts`
- Modify: `src/codex/mcp-server.ts`
- Test: `test/unit/core/job-launcher.test.ts`
- Test: six files under `test/unit/mcp-tools/mimo-{plan,implement,review,fix-ci,resume}.test.ts` and `test/unit/compose-background.test.ts`
- Test: `test/unit/tool-schemas.test.ts`

**Interfaces:**
- Consumes: target resolver, job store, worker process spawn.
- Produces: `launchJob(request, deps?)`, common `JobOptionsSchema`, six work input schemas, and six receipt-only handlers.

- [ ] **Step 1: Replace work-tool tests with receipt assertions**

```ts
const workCases: Array<{ name: string; kind: JobKind; run: () => Promise<JobReceipt> }> = [
  { name: "mimo_plan", kind: "plan", run: () => mimoPlan({ cwd, task: "plan it" }, launcherDeps) },
  { name: "mimo_implement", kind: "implement", run: () => mimoImplement({ cwd, task: "build it", allowWrite: true }, launcherDeps) },
  { name: "mimo_review", kind: "review", run: () => mimoReview({ cwd, base: "HEAD" }, launcherDeps) },
  { name: "mimo_fix_ci", kind: "fix-ci", run: () => mimoFixCi({ cwd, file: "ci.log", task: "fix" }, launcherDeps) },
  { name: "mimo_compose", kind: "compose", run: () => mimoCompose({ cwd, workflow: "dev", task: "build" }, launcherDeps) }
];

it.each(workCases)("$name returns only a queued receipt", async ({ run, kind }) => {
  const result = await run();
  expect(result).toEqual({
    jobId: expect.any(String), kind, status: "queued",
    actions: { status: "mimo_status", events: "mimo_events", result: "mimo_result", cancel: "mimo_cancel" }
  });
});
```

Test `mimo_resume({cwd, jobId, task})` separately after Task 10. Schema tests assert work schemas contain no `background`, `wait`, `pollMs`, `agent`, `allowInstall`, direct `session`, `attach`, `fork`, `continue`, or `dryRun` fields. Keep only approved per-tool fields plus `cwd`, `model`, `timeoutMs`, and `notify`.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm.cmd test -- test/unit/core/job-launcher.test.ts test/unit/mcp-tools/mimo-plan.test.ts test/unit/mcp-tools/mimo-implement.test.ts test/unit/mcp-tools/mimo-review.test.ts test/unit/mcp-tools/mimo-fix-ci.test.ts test/unit/compose-background.test.ts test/unit/tool-schemas.test.ts`

Expected: FAIL because handlers still execute synchronously or branch on foreground/background.

- [ ] **Step 3: Implement launcher and common schemas**

```ts
export interface LaunchJobInput {
  kind: JobKind;
  cwd: string;
  task: string;
  request: unknown;
  parentJobId?: string;
  notify?: NotificationInput;
}

export function toJobReceipt(job: JobRecord): JobReceipt {
  return {
    jobId: job.id, kind: job.kind, status: "queued",
    actions: { status: "mimo_status", events: "mimo_events", result: "mimo_result", cancel: "mimo_cancel" }
  };
}
```

`launchJob()` resolves/freezes the target before writing, validates `allowWrite === true` for implement, creates the job, starts `job-worker`, and returns the receipt immediately. If spawning fails, transition the persisted job to `failed` and throw the launch error; never return a false queued receipt.

Define `NotifySchema` as the Zod discriminated union and merge the common fields into six strict schemas. MCP server definitions must use those schemas' `.shape` so registered schemas and handler parsing cannot drift.

- [ ] **Step 4: Replace the five independent work-handler bodies with launcher calls**

Plan, implement, review, fix-ci, and Compose each parse their schema, build only the stored request, and call `launchJob()`. Remove direct `runAndCapture`, foreground Compose, handler-side result compaction, and AbortSignal waiting. Task 10 adds the sixth work tool, parent-job resume, because it depends on the control/read contract.

- [ ] **Step 5: Run tests and commit**

Run: `npm.cmd test -- test/unit/core/job-launcher.test.ts test/unit/mcp-tools/mimo-plan.test.ts test/unit/mcp-tools/mimo-implement.test.ts test/unit/mcp-tools/mimo-review.test.ts test/unit/mcp-tools/mimo-fix-ci.test.ts test/unit/compose-background.test.ts test/unit/tool-schemas.test.ts`

Expected: PASS and every work call returns before the fake worker runs.

```powershell
git add src/core/job-launcher.ts src/codex/tool-schemas.ts src/codex/tools.ts src/codex/mcp-server.ts test/unit/core/job-launcher.test.ts test/unit/mcp-tools test/unit/compose-background.test.ts test/unit/tool-schemas.test.ts
git commit -m "feat: launch every MCP work tool in background"
```

### Task 10: Control Tools, Attention-Only Wait, and Parent-Job Resume

**Files:**
- Modify: `src/core/job-render.ts`
- Modify: `src/codex/tool-schemas.ts`
- Modify: `src/codex/tools.ts`
- Modify: `src/codex/mcp-server.ts`
- Modify: `src/codex/tool-names.ts`
- Test: `test/unit/job-render.test.ts`
- Test: `test/unit/mcp-tools/mimo-{status,events,wait,result,cancel,jobs,resume}.test.ts`
- Test: `test/unit/codex-tools.test.ts`

**Interfaces:**
- Consumes: unified job record, transition API, signal reader, launcher, and notification outbox status.
- Produces: final 13-tool surface and the only resume contract `mimo_resume({cwd, jobId, task, ...JobOptions})`.

- [ ] **Step 1: Write failing control-contract tests**

```ts
it("wait ignores milestones and returns on attention", async () => {
  appendJobSignal(file, milestoneAt(1));
  const waiting = mimoWait({ cwd, jobId, sinceCursor: 0, timeoutMs: 100 });
  appendJobSignal(file, completedAt(2));
  expect((await waiting).signals.map((signal) => signal.kind)).toEqual(["completed"]);
});

it.each(["needs_input", "blocked", "completed", "failed", "cancelled", "timeout"] as const)
  ("result reads %s jobs", async (status) => {
    seedJob({ status });
    expect((await mimoResult({ cwd, jobId })).status).toBe(status);
  });

it.each(["queued", "running"] as const)("result rejects %s jobs", async (status) => {
  seedJob({ status });
  await expect(mimoResult({ cwd, jobId })).rejects.toThrow("Job result is not available");
});
```

Resume test: seed a `blocked` parent with `sessionId: "ses_parent"`; call `mimo_resume`; assert a child `resume` job has `parentJobId`, stored `sessionId`, inherited frozen target unless explicitly overridden, and queued receipt. Cancel must use `transitionJob()` and start notification delivery.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm.cmd test -- test/unit/job-render.test.ts test/unit/mcp-tools/mimo-status.test.ts test/unit/mcp-tools/mimo-events.test.ts test/unit/mcp-tools/mimo-wait.test.ts test/unit/mcp-tools/mimo-result.test.ts test/unit/mcp-tools/mimo-cancel.test.ts test/unit/mcp-tools/mimo-jobs.test.ts test/unit/mcp-tools/mimo-resume.test.ts test/unit/codex-tools.test.ts`

Expected: FAIL on old result restrictions, ordinary-signal wait, and session-based resume.

- [ ] **Step 3: Implement compact status/result rendering**

Status returns identity, status/phase, elapsed time, session, summary, changed files, latest progress, notification `{targetType,status,attempts,lastError}` and valid actions. Result returns partial/final fields, execution callback, verification/report paths/error, notification state, and a resume action only for `needs_input`/`blocked`. Neither response contains prompt, full logs, raw JSONL, or full diff.

- [ ] **Step 4: Replace wait and resume behavior**

Filter `mimo_wait` with `isAttentionSignal()` before deciding to return; keep the internal filesystem check interval private at 1 second and remove public `pollMs`. Timeout returns an empty signal list plus current job status, not a fabricated heartbeat.

`mimo_resume` accepts a parent `jobId`, permits only `needs_input`/`blocked` parents with a session ID, creates a child through `launchJob()`, and uses explicit notify override or the parent's frozen target. Remove `mimo_wake` and `mimo_resume_job` imports, registrations, names, schemas, handlers, hints, and tests.

- [ ] **Step 5: Run tests and commit**

Run: `npm.cmd test -- test/unit/job-render.test.ts test/unit/mcp-tools test/unit/codex-tools.test.ts test/unit/tool-schemas.test.ts`

Expected: PASS; `MIMO_TOOL_NAMES` has exactly 13 entries and contains neither removed tool.

```powershell
git add src/core/job-render.ts src/codex test/unit/job-render.test.ts test/unit/mcp-tools test/unit/codex-tools.test.ts test/unit/tool-schemas.test.ts
git commit -m "refactor: expose attention-driven job controls"
```

### Task 11: CLI Migration and Internal Worker Commands

**Files:**
- Modify: `src/cli/main.ts`
- Modify: `src/cli/commands.ts`
- Modify: `src/cli/hints.ts`
- Test: `test/unit/cli.test.ts`
- Test: `test/unit/compose-cli-args.test.ts`

**Interfaces:**
- Consumes: `launchJob()`, control functions, `runJobWorker()`, and `runNotificationWorker()`.
- Produces: background work commands, `status/events/wait/result/cancel/jobs`, internal `job-worker/notify-worker`, and stable process exit codes.

- [ ] **Step 1: Replace CLI tests with the unified command matrix**

```ts
it.each(["plan", "implement", "review", "fix-ci", "resume", "compose"])
  ("%s prints a queued receipt", async (command) => {
    const result = await invokeCli(commandFixture(command));
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "queued", actions: { result: "mimo_result" } });
    expect(result.elapsedMs).toBeLessThan(1_000);
  });

it.each(["status", "events", "wait", "result", "cancel", "jobs"])
  ("supports %s as a public control command", async (command) => {
    expect((await invokeCli([command, "--cwd", cwd, "--job-id", jobId, "--json"])).status).toBe(0);
  });
```

Assert `compose-worker`, `sessions`, `--background`, and `--wait` are rejected. Assert `job-worker --job-id` and `notify-worker --cwd` invoke internal functions without printing normal work output.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm.cmd test -- test/unit/cli.test.ts test/unit/compose-cli-args.test.ts`

Expected: FAIL because CLI work commands are synchronous and old commands remain.

- [ ] **Step 3: Rebuild CLI dispatch around shared APIs**

Use one parsed `cwd`, `model`, `timeoutMs`, and notification option path. Public work commands call the same launcher builders as MCP and print `JobReceipt` JSON by default. `implement` requires `--allow-write`. `resume` requires `--job-id`, not `--session`. Control commands call the same Codex-layer control functions. Internal commands call `runJobWorker()` or `runNotificationWorker()` directly.

Retain `doctor` and `healthcheck`; update the canonical usage line to:

```text
codex-mimo <plan|implement|review|fix-ci|resume|compose|status|events|wait|result|cancel|jobs|doctor|healthcheck>
```

- [ ] **Step 4: Run tests and commit**

Run: `npm.cmd test -- test/unit/cli.test.ts test/unit/compose-cli-args.test.ts`

Expected: PASS.

```powershell
git add src/cli/main.ts src/cli/commands.ts src/cli/hints.ts test/unit/cli.test.ts test/unit/compose-cli-args.test.ts
git commit -m "refactor: share background jobs with CLI"
```

### Task 12: Remove Replaced Runtime and Prove the Static Surface Is Clean

**Files:**
- Delete: `src/codex/wake.ts`, `src/codex/compact.ts`
- Delete: `src/core/job-runtime.ts`, `src/core/job-phase.ts`, `src/core/sessions.ts`
- Delete: `src/mimo/mimo-runner.ts`
- Delete: `src/compose/job-worker.ts`, `src/compose/runner.ts`, `src/compose/streaming-runner.ts`
- Delete/replace: tests dedicated to those removed contracts
- Modify: imports throughout `src` and `test`

**Interfaces:**
- Consumes: all replacement APIs from Tasks 1–11.
- Produces: no runtime reference to synchronous runner, wake/heartbeat, session-store resume, foreground Compose, Compose worker, or `acp` job kind.

- [ ] **Step 1: Add a failing static-contract test**

Create an assertion in `test/unit/codex-tools.test.ts` that recursively reads `src/**/*.ts` and fails when source contains any of these identifiers outside test fixtures: `mimo_wake`, `mimo_resume_job`, `compose-worker`, `runAndCapture`, `runComposeWorkflow`, `runComposeJobWorker`, `JobWakeHint`, or `"acp"` as a job kind. Add a plugin schema assertion that work tools contain neither `background` nor `wait`.

- [ ] **Step 2: Run static tests and confirm RED**

Run: `npm.cmd test -- test/unit/codex-tools.test.ts test/unit/plugin-mcp-config.test.ts`

Expected: FAIL and report the remaining old identifiers.

- [ ] **Step 3: Delete old files and imports with `apply_patch`**

Delete the listed files only after `rg` shows each public behavior is implemented by its replacement. Delete the tests for wake, compacting, direct runner, session store, old job phase/runtime, foreground Compose runner, Compose-specific worker, and `mimo_resume_job`; keep and move reusable process/event/report assertions to the new tests. Do not leave forwarding exports or empty compatibility modules.

- [ ] **Step 4: Verify no dead surface remains**

Run:

```powershell
rg -n 'mimo_wake|mimo_resume_job|compose-worker|runAndCapture|runComposeWorkflow|runComposeJobWorker|JobWakeHint|JobKind.*acp|background.*z\.boolean|wait.*z\.boolean' src test scripts skills README.md doc
npm.cmd run lint
npm.cmd test -- test/unit/codex-tools.test.ts test/unit/plugin-mcp-config.test.ts
```

Expected: `rg` returns no matches except explicit negative assertions and approved design/history documents; lint and tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add -A src test
git commit -m "refactor: remove superseded execution paths"
```

### Task 13: Integration Matrix, Plugin Guidance, Documentation, and Final Verification

**Files:**
- Create: `test/integration/unified-background-jobs.test.ts`
- Create: `test/smoke/local-codex-notification.test.ts`
- Modify: `test/smoke/local-mimo-hooks.test.ts`
- Modify: `package.json`
- Modify: `scripts/validate-plugin.mjs`
- Modify: `skills/mimocode/SKILL.md`
- Modify: `README.md`
- Modify: `doc/operations-guide.md`
- Modify: `doc/compose-workflows.md`

**Interfaces:**
- Consumes: complete runtime and public APIs.
- Produces: executable acceptance coverage, gated real-machine smoke, and the final no-poll public guidance.

- [ ] **Step 1: Write the failing fake-process integration matrix**

Create a fake MiMo executable that emits JSONL and invokes the injected `session.post` URL. Use table-driven tests for all six kinds and dedicated cases for completed, verification failure, callback missing, timeout, cancel, `needs_input`, `blocked`, job-worker restart, notification-worker expired-lease recovery, webhook delivery, and Codex App Server delivery.

The successful Codex case must assert:

```ts
expect(receipt.status).toBe("queued");
expect(waitToolCalls).toBe(0);
expect(appServerCalls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
expect(appServerCalls.filter((call) => call.method === "turn/start")).toHaveLength(1);
expect(JSON.parse(readFileSync(job.notificationOutboxFile, "utf8").trim()).target).toEqual({
  type: "codex", threadId: "thread-test"
});
```

The webhook case verifies event-ID deduplication and HMAC; the secret string must not occur in any file below `.codex-mimo`.

- [ ] **Step 2: Run integration tests and confirm RED, then make only fixture-level corrections**

Run: `npm.cmd test -- test/integration/unified-background-jobs.test.ts`

Expected before fixture wiring: FAIL because fake process/App Server scripts are not yet connected. Complete the fixture using dependency-injection seams already created; if a production API is missing, add the smallest typed seam to its owning file and a focused unit assertion.

- [ ] **Step 3: Update plugin validation and packaged skill**

Validator assertions must inspect the built MCP tool list for exactly 13 names, reject removed names and old work-schema fields, and scan `skills/mimocode/SKILL.md` for loop instructions. The skill must direct Codex to:

1. call one work tool;
2. return the queued receipt without calling `mimo_wait`;
3. rely on the callback turn;
4. call `mimo_result` when resumed;
5. use `mimo_status`, `mimo_events`, or one `mimo_wait` only for explicit user diagnostics.

- [ ] **Step 4: Add gated Windows smoke**

Add script:

```json
"test:smoke:codex-notify": "vitest run test/smoke/local-codex-notification.test.ts"
```

Gate the test on `RUN_LOCAL_CODEX_NOTIFY_SMOKE=1`. It must start an implement job through the packaged plugin, use injected `CODEX_THREAD_ID`, never call wait, observe exactly one resume/start-turn for the same thread, and confirm the resumed turn reads `mimo_result`. Keep the existing hook smoke gated separately.

- [ ] **Step 5: Rewrite operational documentation**

Document the unified lifecycle, eight statuses, parent-job resume, webhook headers/signature, secret handling, retry isolation, control commands, and recovery. Remove all foreground/background choice, heartbeat, wake, direct session resume, and frequent wait advice. State clearly that `CODEX_THREAD_ID` is injected per Codex task and must not be configured globally on Windows.

- [ ] **Step 6: Run full verification**

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run lint
npm.cmd run validate:plugin
$env:RUN_LOCAL_MIMO_HOOK_SMOKE='1'; npm.cmd run test:smoke:mimo-hooks
git diff --check
```

Expected: all commands PASS. Run `npm.cmd run test:smoke:codex-notify` only when `RUN_LOCAL_CODEX_NOTIFY_SMOKE=1` and a real Codex App Server is available; otherwise record it as intentionally gated, not silently passed.

- [ ] **Step 7: Perform final approved-spec audit**

Check each completion criterion in the approved spec against test evidence. Run:

```powershell
rg -n 'mimo_wait' skills README.md doc src/codex
rg -n 'CODEX_THREAD_ID|X-Codex-Mimo-Event-Id|X-Codex-Mimo-Signature|needs_input|blocked' README.md doc skills src
git status --short
```

Expected: `mimo_wait` appears only as an explicit diagnostic control, all notification contract terms are documented/implemented, and `.mimocode/.cron-lock` remains untouched.

- [ ] **Step 8: Commit the acceptance layer**

```powershell
git add package.json scripts/validate-plugin.mjs skills/mimocode/SKILL.md README.md doc test/integration test/smoke
git commit -m "docs: finalize background notification workflow"
```

## Execution Checkpoints

- After Task 3: review the status graph and outcome precedence before adapter work.
- After Task 6: review outbox lease/retry behavior and confirm notification failures cannot mutate jobs.
- After Task 8: review one complete fake job for each kind before exposing it through MCP.
- After Task 10: inspect `tools/list` and schemas before deleting old paths.
- After Task 13: compare the full verification output and gated-smoke status with every approved completion criterion.
