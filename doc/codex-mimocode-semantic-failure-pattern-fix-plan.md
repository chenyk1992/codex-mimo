# Codex-MiMo Semantic Failure Pattern Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or an equivalent task-by-task execution loop. Implement this plan with TDD. Keep all changes surgical. Do not alter the compact MCP response contract.

**Goal:** Fix the remaining real Codex MCP test failure where MiMoCode asks for a task/objective but `mimo_compose` reports `status: passed`.

**Architecture:** `runComposeWorkflow()` already parses MiMo JSONL output and has `detectSemanticFailure()`. Extend that detector with the exact real-world phrases observed after the Codex app restart, and add regression tests using those phrases. Do not change workflow definitions, MCP schemas, plugin docs, or compact response formatting unless tests prove it is necessary.

**Tech Stack:** TypeScript, NodeNext ESM, Vitest, MiMoCode MCP bridge.

---

## Real Failure Evidence

### Failure A: `plan` non-dry-run falsely passed

**Real command path:**

```text
Codex app -> mcp__codex_mimocode.mimo_compose -> workflow=plan -> dryRun=false
```

**Real event log text:**

```text
It looks like your message got cut off — what's the objective or task you'd like help with?
```

**Wrong result:**

```json
{
  "workflow": "plan",
  "status": "passed",
  "changedFiles": []
}
```

### Failure B: `brainstorm` non-dry-run falsely passed

**Real command path:**

```text
Codex app -> mcp__codex_mimocode.mimo_compose -> workflow=brainstorm -> dryRun=false
```

**Real event log text:**

```text
I see you've loaded the compose agent environment with all the skills, but you haven't provided an actual task or objective yet.

What would you like me to help you with? Please share your task, and I'll use the appropriate skills to assist you.
```

**Wrong result:**

```json
{
  "workflow": "brainstorm",
  "status": "passed",
  "changedFiles": []
}
```

### Failure C: post-fix `plan` retest still falsely passed

**Real command path:**

```text
Fresh MCP stdio server -> mimo_compose -> workflow=plan -> dryRun=false
```

**Real event log text:**

```text
What would you like to work on?
```

### Failure D: post-fix raw message text was not normalized

**Real event JSONL shape:**

```json
{
  "type": "message",
  "raw": {
    "type": "text",
    "part": {
      "type": "text",
      "text": "It looks like your message got cut off. What would you like to accomplish?"
    }
  }
}
```

**Wrong result:**

```text
Status: passed
Review: No review text was captured.
```

**Additional root cause:**

`parseMimoJsonLines()` classified the event as `type: "message"` but did not extract text from `raw.part.text`, so both `detectSemanticFailure()` and `extractReviewText()` missed the real message.

**Wrong result:**

```json
{
  "workflow": "plan",
  "status": "passed",
  "changedFiles": []
}
```

## Root Cause

`src/compose/runner.ts` has a semantic failure detector, but it only checks this limited set:

```text
objective is empty
what would you like me to help with
task is empty
no objective provided
no task provided
```

The real MiMoCode outputs use different wording:

```text
message got cut off
what's the objective
haven't provided an actual task or objective
please share your task
what would you like to work on
what would you like to accomplish
```

Therefore `detectSemanticFailure()` returns `undefined`, and `determineStatus()` later reports `passed`.

---

## File Structure

- Modify: `test/unit/compose-runner.test.ts`
  - Add regression tests using the exact real event text.
- Modify: `src/compose/runner.ts`
  - Extend `detectSemanticFailure()` phrase patterns only.
  - Keep the existing read-only detection and report construction unchanged.
- Do not modify: `src/codex/compact.ts`
  - The compact MCP response contract must remain intact.
- Do not modify: workflow schemas/docs unless a failing test requires it.

---

## Task 1: Add Regression Tests For Real MiMo Task-Missing Phrases

**Files:**
- Modify: `test/unit/compose-runner.test.ts`

- [ ] **Step 1: Add exact plan failure regression test**

Append this test inside `describe("compose runner", ...)`:

```ts
it("marks MiMoCode cut-off objective clarification as failed", async () => {
  const result = await runComposeWorkflow(
    {
      cwd: "E:/project/app",
      workflow: "plan",
      task: "Create a concise read-only validation plan.",
      reportDir: "E:/project/app/.codex-mimo/reports"
    },
    {
      runMimo: async () => ({
        stdout:
          '{"type":"message","text":"It looks like your message got cut off — what\\'s the objective or task you\\'d like help with?"}\\n',
        stderr: "",
        exitCode: 0
      }),
      captureDiff: async () => ({
        changedFiles: [],
        diffStat: "",
        diff: ""
      }),
      captureStatus: async () => ({
        short: "",
        dirty: false
      }),
      runVerification: async () => [],
      writeReport: () => undefined,
      now: () => new Date("2026-06-22T04:30:00.000Z")
    }
  );

  expect(result.status).toBe("failed");
  expect(result.error).toContain("MiMoCode did not receive or accept the task objective");
  expect(result.reviewText).toContain("message got cut off");
});
```

- [ ] **Step 2: Add exact brainstorm failure regression test**

Append this test inside `describe("compose runner", ...)`:

```ts
it("marks MiMoCode missing actual task clarification as failed", async () => {
  const result = await runComposeWorkflow(
    {
      cwd: "E:/project/app",
      workflow: "brainstorm",
      task: "Clarify whether this tiny smoke fixture needs any changes.",
      reportDir: "E:/project/app/.codex-mimo/reports"
    },
    {
      runMimo: async () => ({
        stdout:
          '{"type":"message","text":"I see you\\'ve loaded the compose agent environment with all the skills, but you haven\\'t provided an actual task or objective yet.\\n\\nWhat would you like me to help you with? Please share your task, and I\\'ll use the appropriate skills to assist you."}\\n',
        stderr: "",
        exitCode: 0
      }),
      captureDiff: async () => ({
        changedFiles: [],
        diffStat: "",
        diff: ""
      }),
      captureStatus: async () => ({
        short: "",
        dirty: false
      }),
      runVerification: async () => [],
      writeReport: () => undefined,
      now: () => new Date("2026-06-22T04:31:00.000Z")
    }
  );

  expect(result.status).toBe("failed");
  expect(result.error).toContain("MiMoCode did not receive or accept the task objective");
  expect(result.reviewText).toContain("haven't provided an actual task or objective");
});
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
npm test -- compose-runner.test.ts
```

Expected:

```text
FAIL test/unit/compose-runner.test.ts
expected 'passed' to be 'failed'
```

If the sandbox reports `spawn EPERM`, rerun with the existing elevated Vitest path.

---

## Task 2: Extend Semantic Failure Detection

**Files:**
- Modify: `src/compose/runner.ts`

- [ ] **Step 1: Update `detectSemanticFailure()` patterns**

Find `emptyObjectivePatterns` in `src/compose/runner.ts` and extend it to exactly:

```ts
  const emptyObjectivePatterns = [
    "objective is empty",
    "what would you like me to help with",
    "task is empty",
    "no objective provided",
    "no task provided",
    "message got cut off",
    "what's the objective",
    "what is the objective",
    "haven't provided a task",
    "haven't provided an actual task or objective",
    "please share your task",
    "what would you like to work on",
    "what would you like to accomplish"
  ];
```

### Task 2.5: Normalize Real MiMo Raw Message Text

**Files:**
- Modify: `src/compose/events.ts`
- Modify: `test/unit/compose-events.test.ts`

- [ ] **Step 1: Add parser regression test**

Add this test to `test/unit/compose-events.test.ts`:

```ts
it("extracts text from MiMo raw message parts", () => {
  const events = parseMimoJsonLines(
    '{"type":"message","raw":{"type":"text","part":{"type":"text","text":"What would you like to accomplish?"}}}\n'
  );

  expect(events[0]).toMatchObject({
    type: "message",
    text: "What would you like to accomplish?"
  });
});
```

- [ ] **Step 2: Implement nested text extraction**

In `src/compose/events.ts`, update message normalization to fall back to a helper that reads:

```text
raw.raw.part.text
raw.raw.text
raw.raw.content
raw.raw.message
```

- [ ] **Step 3: Add runner regression test using raw message shape**

Add a `compose-runner` test with this stdout:

```ts
'{"type":"message","raw":{"type":"text","part":{"type":"text","text":"It looks like your message got cut off. What would you like to accomplish?"}}}\n'
```

Expected:

```text
status: failed
reviewText contains "What would you like to accomplish?"
```

Keep the return message unchanged:

```ts
return "MiMoCode did not receive or accept the task objective.";
```

- [ ] **Step 2: Do not broaden detection beyond task-missing signals**

Do not add generic phrases such as:

```text
clarify
question
what would you like
help with
```

Those are too broad and could mark normal brainstorm output as failed.

- [ ] **Step 3: Run focused tests and verify they pass**

Run:

```bash
npm test -- compose-runner.test.ts
```

Expected:

```text
PASS test/unit/compose-runner.test.ts
```

---

## Task 3: Full Verification

**Files:**
- No extra source files.

- [ ] **Step 1: Run focused bridge tests**

Run:

```bash
npm test -- compose-runner.test.ts compose-workflow.test.ts tool-schemas.test.ts codex-compact.test.ts
```

Expected:

```text
PASS test/unit/compose-runner.test.ts
PASS test/unit/compose-workflow.test.ts
PASS test/unit/tool-schemas.test.ts
PASS test/unit/codex-compact.test.ts
```

- [ ] **Step 2: Run build and full tests**

Run:

```bash
npm run build
npm run lint
npm test
```

Expected:

```text
build exit 0
lint exit 0
all test files passed
```

- [ ] **Step 3: Real Codex MCP retest in isolated fixture**

Create or reuse an isolated git fixture outside the main repository, then call:

```json
{
  "cwd": "<isolated-fixture>",
  "workflow": "plan",
  "task": "Create a concise read-only validation plan for this tiny smoke fixture. Do not edit files.",
  "dryRun": false
}
```

and:

```json
{
  "cwd": "<isolated-fixture>",
  "workflow": "brainstorm",
  "task": "Clarify whether this tiny smoke fixture needs any changes. Do not edit files.",
  "dryRun": false
}
```

Expected if MiMoCode produces the task-missing text again:

```text
status: failed
error contains "MiMoCode did not receive or accept the task objective"
changedFiles does not include source files
reportPaths present
```

Expected if MiMoCode actually accepts the task:

```text
status: passed or needs_review
changedFiles: []
reportPaths present
events do not contain the task-missing phrases
```

Either outcome is acceptable only if it matches the actual event text.

---

## Acceptance Criteria

- The two new regression tests fail before implementation and pass after implementation.
- `detectSemanticFailure()` catches:
  - `message got cut off`
  - `what's the objective`
  - `haven't provided an actual task or objective`
  - `please share your task`
  - `what would you like to work on`
  - `what would you like to accomplish`
- `parseMimoJsonLines()` extracts message text from real MiMo raw wrapper events.
- Reports with those event messages return `status: failed`.
- The report error is exactly or effectively:

```text
MiMoCode did not receive or accept the task objective.
```

- `reviewText` still preserves the MiMo message in the on-disk report.
- `compactComposeReportForCodex()` remains compact and does not inline full events, raw logs, full diffs, or `mimoArgs`.
- `npm run build`, `npm run lint`, and `npm test` pass.
