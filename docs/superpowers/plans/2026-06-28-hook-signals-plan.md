# Hook Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compact signal channel for long-running MiMoCode jobs so Codex can consume high-signal progress and results without polling verbose logs or loading full command output.

**Architecture:** Keep raw MiMo JSONL and full reports as durable artifacts, but add a small `JobSignal` journal beside each job. Runtime event processing and final job transitions emit deduplicated, cursor-addressable signals; MCP tools expose incremental signal reads and compact job results.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, MCP SDK, existing `.codex-mimo/jobs` runtime store.

---

### Task 1: Job Signal Model And Storage

**Files:**
- Create: `src/core/job-signals.ts`
- Modify: `src/core/jobs.ts`
- Test: `test/unit/job-signals.test.ts`

- [ ] **Step 1: Write failing storage tests**

Add tests that append and read cursor-addressable signal events:

```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendJobSignal, readJobSignals } from "../../src/core/job-signals.js";

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-signals-")), "signals.jsonl");
}

describe("job signals", () => {
  it("appends compact signals and reads them by cursor", () => {
    const file = tempFile();
    appendJobSignal(file, { jobId: "job-1", kind: "phase_changed", level: "info", phase: "starting", summary: "Starting." });
    appendJobSignal(file, { jobId: "job-1", kind: "milestone", level: "info", phase: "investigating", summary: "Read source files." });

    const first = readJobSignals(file);
    expect(first.nextCursor).toBe(2);
    expect(first.signals.map((signal) => signal.cursor)).toEqual([1, 2]);
    expect(first.signals[0]).toMatchObject({ jobId: "job-1", kind: "phase_changed", summary: "Starting." });

    const second = readJobSignals(file, { sinceCursor: 1 });
    expect(second.signals.map((signal) => signal.cursor)).toEqual([2]);
  });

  it("filters by level and limit without reading invalid lines as signals", () => {
    const file = tempFile();
    fs.writeFileSync(file, "not-json\n", "utf8");
    appendJobSignal(file, { jobId: "job-1", kind: "milestone", level: "debug", summary: "Noisy." });
    appendJobSignal(file, { jobId: "job-1", kind: "failed", level: "error", summary: "Failed." });

    const result = readJobSignals(file, { minLevel: "info", limit: 1 });
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({ cursor: 2, kind: "failed", level: "error" });
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm.cmd test -- test/unit/job-signals.test.ts`

Expected: fail because `src/core/job-signals.ts` does not exist.

- [ ] **Step 3: Implement signal storage**

Create `JobSignalKind`, `JobSignalLevel`, `JobSignal`, `appendJobSignal()`, and `readJobSignals()`. Keep payload compact and JSONL-based. Use 1-based cursors derived from valid signal lines only.

- [ ] **Step 4: Run signal tests**

Run: `npm.cmd test -- test/unit/job-signals.test.ts`

Expected: pass.

### Task 2: Emit Signals From Runtime Events And Final Transitions

**Files:**
- Modify: `src/core/jobs.ts`
- Modify: `src/core/job-runtime.ts`
- Modify: `src/core/job-store.ts`
- Test: `test/unit/job-runtime.test.ts`
- Test: `test/unit/job-store.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Add tests proving `startRuntimeJob`, `appendRuntimeEvent`, `completeRuntimeJob`, and `failRuntimeJob` write high-signal entries to the job signal file. The test should assert phase-change dedupe: repeated events that keep the same phase do not create duplicate `phase_changed` signals.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm.cmd test -- test/unit/job-runtime.test.ts test/unit/job-store.test.ts`

Expected: fail because jobs have no `signalsFile` and runtime functions do not write signals.

- [ ] **Step 3: Add `signalsFile` to job records**

Extend `JobRecord` and job creation so each job stores `.codex-mimo/jobs/<jobId>.signals.jsonl`.

- [ ] **Step 4: Emit compact runtime signals**

Emit:
- `phase_changed` when phase changes.
- `milestone` for non-empty summaries that are not duplicate noise.
- `completed`, `failed`, `cancelled`, and `timeout` on terminal transitions.

- [ ] **Step 5: Run runtime tests**

Run: `npm.cmd test -- test/unit/job-runtime.test.ts test/unit/job-store.test.ts`

Expected: pass.

### Task 3: Add Incremental MCP Signal Read API

**Files:**
- Modify: `src/codex/tool-schemas.ts`
- Modify: `src/codex/tools.ts`
- Modify: `src/codex/mcp-server.ts`
- Test: `test/unit/mcp-tools/mimo-events.test.ts`
- Test: `test/unit/tool-schemas.test.ts`

- [ ] **Step 1: Write failing MCP tests**

Create tests for a new `mimo_events` tool:

```typescript
const result = await mimoEvents({ cwd, jobId: job.id, sinceCursor: 1, minLevel: "info" });
expect(result.jobId).toBe(job.id);
expect(result.nextCursor).toBe(2);
expect(result.signals).toHaveLength(1);
```

Also test default job selection uses the most recent job and unknown `jobId` throws.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm.cmd test -- test/unit/mcp-tools/mimo-events.test.ts test/unit/tool-schemas.test.ts`

Expected: fail because schema/tool does not exist.

- [ ] **Step 3: Implement `mimo_events`**

Add schema fields:
- `cwd: string`
- `jobId?: string`
- `sinceCursor?: number`
- `limit?: number`
- `minLevel?: "debug" | "info" | "warn" | "error"`

Return `{ jobId, status, phase, nextCursor, signals, actions }`.

- [ ] **Step 4: Register MCP tool**

Add `mimo_events` to `MIMO_TOOL_NAMES` and `createMcpServer()`.

- [ ] **Step 5: Run MCP tests**

Run: `npm.cmd test -- test/unit/mcp-tools/mimo-events.test.ts test/unit/tool-schemas.test.ts`

Expected: pass.

### Task 4: Compact Status And Result Outputs

**Files:**
- Modify: `src/core/job-render.ts`
- Modify: `src/core/jobs.ts`
- Modify: `src/codex/compact.ts`
- Test: `test/unit/job-render.test.ts`
- Test: `test/unit/codex-compact.test.ts`

- [ ] **Step 1: Write failing compactness tests**

Add tests that job results return verification summaries without `stdout` or `stderr`, and expose signal cursor hints. For foreground compose compact reports, keep report paths and review/plan text, but do not include raw command output.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm.cmd test -- test/unit/job-render.test.ts test/unit/codex-compact.test.ts`

Expected: fail until render types include signal hints and compact verification fields.

- [ ] **Step 3: Implement compact render updates**

Add `signals?: { tool: "mimo_events"; nextCursor?: number }` hints to launch/status/result shapes. Keep verification entries to `{ command, exitCode, passed, durationMs }`.

- [ ] **Step 4: Run compactness tests**

Run: `npm.cmd test -- test/unit/job-render.test.ts test/unit/codex-compact.test.ts`

Expected: pass.

### Task 5: Documentation And Verification

**Files:**
- Modify: `doc/operations-guide.md`
- Modify: `doc/compose-workflows.md`
- Modify: `skills/mimocode/SKILL.md`
- Test: full unit suite

- [ ] **Step 1: Document signal workflow**

Document that long tasks should use `background: true`, then `mimo_events` for incremental high-signal events, and `mimo_result` only when a terminal signal appears.

- [ ] **Step 2: Update plugin skill guidance**

Teach Codex to avoid frequent `mimo_status` polling for long jobs. Prefer `mimo_events` with a stored cursor and read full reports only on failure or review.

- [ ] **Step 3: Run full verification**

Run: `npm.cmd test`

Expected: all tests pass.

Run: `npm.cmd run build`

Expected: TypeScript build passes.

### Deferred Task: Codex Thread Wake Adapter

Do not implement this in the first pass. After signal APIs are stable, add an adapter that can create a heartbeat automation or send a thread follow-up when `mimo_events` contains `needs_input`, `completed`, `failed`, `cancelled`, or `timeout`. Keep this adapter outside the core job runtime so the plugin remains usable in non-Codex hosts.
