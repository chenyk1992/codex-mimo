# Codex-MiMo Real MCP Read-Only Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or an equivalent task-by-task execution loop. Implement this plan with TDD. Keep Codex responses compact: do not inline full events, full diffs, or long logs; write them to `.codex-mimo/` and expose only `reportPaths`.

**Goal:** Fix the failures found during real Codex app MCP testing: read-only Compose workflows can modify files, semantic task failures can be reported as passed, and the installed plugin skill cache can describe stale workflow support.

**Architecture:** Keep Codex as a lightweight dispatcher/reviewer and MiMoCode as the code-heavy executor. Add hard post-run enforcement in `runComposeWorkflow()` so prompt-only read-only instructions are not trusted. Preserve compact MCP output through `compactComposeReportForCodex()` and keep detailed evidence on disk.

**Tech Stack:** TypeScript, NodeNext ESM, Zod, Vitest, MCP stdio tools, MiMoCode CLI.

---

## Current Failures From Real Codex MCP Testing

### Failure 1: Read-only workflows are not enforced

**Observed command path:**

```text
Codex app -> mcp__codex_mimocode.mimo_compose -> workflow=brainstorm -> dryRun=false
```

**Observed result:**

`brainstorm` is configured as read-only and the generated prompt includes:

```text
This workflow is read-only. Do not modify files.
```

However the real run modified these files:

```text
src/codex/tools.ts
src/mimo/acp-bridge.ts
```

**Root cause:**

`src/compose/runner.ts` only tells MiMoCode not to edit files. It does not enforce `workflow.writesAllowed === false` after MiMoCode returns.

**Required fix:**

After MiMoCode runs and the git diff is captured, if `workflow.writesAllowed === false` and `diff.changedFiles.length > 0`, return a failed report with an explicit error message.

The report must still include:

```text
changedFiles
diffStat
diffPath
gitStatusBefore
gitStatusAfter
reportPaths
```

The MCP response must remain compact through `compactComposeReportForCodex()`.

### Failure 2: Empty-objective/clarification responses can be reported as passed

**Observed command path:**

```text
Codex app -> mcp__codex_mimocode.mimo_compose -> workflow=plan -> dryRun=false
```

**Observed event text:**

```text
It looks like the objective is empty. What would you like me to help with?
```

**Observed report status:**

```text
status: passed
```

**Root cause:**

`determineStatus()` only checks exit code, verification failures, and whether changed files exist without verification. It does not check normalized MiMo events for semantic failure signals.

**Required fix:**

Detect semantic failure messages before returning a passed status. At minimum, the following message patterns must mark the report failed:

```text
objective is empty
what would you like me to help with
task is empty
no objective provided
no task provided
```

The error should be clear:

```text
MiMoCode did not receive or accept the task objective.
```

Do not add broad fuzzy matching that could mark normal plans as failed.

### Failure 3: Plugin skill cache can remain stale after code fixes

**Observed file in Codex app cache:**

```text
C:/Users/Administrator/.codex/plugins/cache/personal/codex-mimocode/0.1.0+codex.20260621162928/skills/mimocode/SKILL.md
```

It still lists:

```text
workflow: "dev|fix|fix-ci|plan|execute-plan|review|parallel"
```

The workspace file already lists:

```text
workflow: "brainstorm|dev|fix|fix-ci|plan|execute-plan|review|parallel|worktree|merge|new-skill"
```

**Root cause:**

The plugin cache was not refreshed even after the workspace skill file changed.

**Required fix:**

Keep workspace docs correct and add explicit release/install verification steps. If the plugin cache is not refreshed automatically, bump the plugin cachebuster/version or run the existing plugin reinstall flow after code changes.

### Failure 4: Accidental code from the failed real brainstorm run must be removed unless needed

**Observed accidental additions:**

```text
src/codex/tools.ts: mimoReviewAcp()
src/mimo/acp-bridge.ts: AcpBridge.review()
```

**Root cause:**

The real `brainstorm` workflow ignored read-only instructions and edited implementation files.

**Required fix:**

Remove these accidental ACP review additions unless the implementation deliberately needs them. The read-only enforcement fix must not depend on these accidental additions.

---

## File Structure

- Modify: `src/compose/runner.ts`
  - Add read-only diff enforcement.
  - Add semantic failure detection.
  - Keep report construction and compact response contract unchanged.
- Modify: `src/compose/report.ts`
  - Only if a small report field/comment is needed. Prefer not to change this file unless tests require it.
- Modify: `test/unit/compose-runner.test.ts`
  - Add regression tests for read-only violation and semantic failure.
- Modify: `src/codex/tools.ts`
  - Remove accidental `mimoReviewAcp()` code if present.
- Modify: `src/mimo/acp-bridge.ts`
  - Remove accidental `review()` code if present.
- Modify: `skills/mimocode/SKILL.md`
  - Ensure it documents all supported workflows and compact response rules.
- Modify: `.codex-plugin/plugin.json`
  - Only if plugin cache refresh requires a version/cachebuster bump.

---

## Task 1: Add Regression Test For Read-Only Workflow Violations

**Files:**
- Modify: `test/unit/compose-runner.test.ts`
- Modify later: `src/compose/runner.ts`

- [ ] **Step 1: Add the failing test**

Append this test to `describe("compose runner", ...)`:

```ts
it("marks read-only workflows as failed when MiMoCode changes files", async () => {
  const result = await runComposeWorkflow(
    {
      cwd: "E:/project/app",
      workflow: "brainstorm",
      task: "Clarify requirements",
      reportDir: "E:/project/app/.codex-mimo/reports"
    },
    {
      runMimo: async () => ({
        stdout: '{"type":"message","text":"I changed a file."}\n',
        stderr: "",
        exitCode: 0
      }),
      captureDiff: async () => ({
        changedFiles: ["src/unexpected.ts"],
        diffStat: " src/unexpected.ts | 1 +",
        diff: "diff --git a/src/unexpected.ts b/src/unexpected.ts"
      }),
      captureStatus: async () => ({
        short: " M src/unexpected.ts",
        dirty: true
      }),
      runVerification: async () => [],
      writeReport: () => undefined,
      now: () => new Date("2026-06-22T03:10:00.000Z")
    }
  );

  expect(result.status).toBe("failed");
  expect(result.changedFiles).toEqual(["src/unexpected.ts"]);
  expect(result.error).toContain("Read-only workflow brainstorm modified files");
  expect(result.diffPath).toBeDefined();
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm test -- compose-runner.test.ts
```

Expected:

```text
FAIL test/unit/compose-runner.test.ts
expected 'needs_review' or 'passed' to be 'failed'
```

If the sandbox reports `spawn EPERM`, rerun with the approved elevated test path.

- [ ] **Step 3: Implement minimal read-only enforcement**

In `src/compose/runner.ts`, after `diff` and `gitStatusAfter` are captured and before verification runs, add:

```ts
  if (!workflow.writesAllowed && diff.changedFiles.length > 0) {
    const report = buildReport({
      id,
      createdAt,
      input,
      mimoArgs,
      requestedSkills: workflow.skillChain,
      eventsStdout: mimoResult.stdout,
      diff,
      verification: [],
      reportDir,
      eventsDir,
      diffsDir,
      status: "failed",
      gitStatusBefore,
      gitStatusAfter,
      error: `Read-only workflow ${workflow.name} modified files: ${diff.changedFiles.join(", ")}`
    });
    writeReport(report);
    return report;
  }
```

Do not move full diff or event data into the MCP response.

- [ ] **Step 4: Run the test and verify it passes**

Run:

```bash
npm test -- compose-runner.test.ts
```

Expected:

```text
PASS test/unit/compose-runner.test.ts
```

---

## Task 2: Add Regression Test For Semantic Empty-Objective Failure

**Files:**
- Modify: `test/unit/compose-runner.test.ts`
- Modify later: `src/compose/runner.ts`

- [ ] **Step 1: Add the failing test**

Append this test to `describe("compose runner", ...)`:

```ts
it("marks MiMoCode empty-objective clarification as failed", async () => {
  const result = await runComposeWorkflow(
    {
      cwd: "E:/project/app",
      workflow: "plan",
      task: "Write a validation plan",
      verification: ["npm run build"],
      reportDir: "E:/project/app/.codex-mimo/reports"
    },
    {
      runMimo: async () => ({
        stdout: '{"type":"message","text":"It looks like the objective is empty. What would you like me to help with?"}\n',
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
      runVerification: async () => [
        {
          command: "npm run build",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          passed: true,
          durationMs: 10
        }
      ],
      writeReport: () => undefined,
      now: () => new Date("2026-06-22T03:11:00.000Z")
    }
  );

  expect(result.status).toBe("failed");
  expect(result.error).toContain("MiMoCode did not receive or accept the task objective");
  expect(result.reviewText).toContain("objective is empty");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm test -- compose-runner.test.ts
```

Expected:

```text
FAIL test/unit/compose-runner.test.ts
expected 'passed' to be 'failed'
```

- [ ] **Step 3: Implement semantic failure detection**

In `src/compose/runner.ts`, add a helper near `determineStatus()`:

```ts
function detectSemanticFailure(eventsStdout: string): string | undefined {
  const events = parseMimoJsonLines(eventsStdout);
  const text = events
    .filter((event) => event.type === "message" && event.text)
    .map((event) => event.text)
    .join("\n")
    .toLowerCase();

  const emptyObjectivePatterns = [
    "objective is empty",
    "what would you like me to help with",
    "task is empty",
    "no objective provided",
    "no task provided"
  ];

  if (emptyObjectivePatterns.some((pattern) => text.includes(pattern))) {
    return "MiMoCode did not receive or accept the task objective.";
  }

  return undefined;
}
```

Then after verification succeeds and before `determineStatus(...)`, add:

```ts
  const semanticFailure = detectSemanticFailure(mimoResult.stdout);
  if (semanticFailure) {
    const report = buildReport({
      id,
      createdAt,
      input,
      mimoArgs,
      requestedSkills: workflow.skillChain,
      eventsStdout: mimoResult.stdout,
      diff,
      verification,
      reportDir,
      eventsDir,
      diffsDir,
      status: "failed",
      gitStatusBefore,
      gitStatusAfter,
      error: semanticFailure
    });
    writeReport(report);
    return report;
  }
```

- [ ] **Step 4: Run the test and verify it passes**

Run:

```bash
npm test -- compose-runner.test.ts
```

Expected:

```text
PASS test/unit/compose-runner.test.ts
```

---

## Task 3: Remove Accidental ACP Review Additions

**Files:**
- Modify: `src/codex/tools.ts`
- Modify: `src/mimo/acp-bridge.ts`

- [ ] **Step 1: Inspect current diff**

Run:

```bash
git diff -- src/codex/tools.ts src/mimo/acp-bridge.ts
```

Expected diff includes accidental additions:

```text
mimoReviewAcp
AcpBridge.review
```

- [ ] **Step 2: Remove accidental imports and function from `src/codex/tools.ts`**

Remove:

```ts
import { AcpBridge } from "../mimo/acp-bridge.js";
import { loadPolicy } from "../core/config.js";
```

Remove the entire:

```ts
export async function mimoReviewAcp(input: unknown) {
  ...
}
```

Keep the existing `mimoReview()` implementation unchanged.

- [ ] **Step 3: Remove accidental imports and method from `src/mimo/acp-bridge.ts`**

Remove:

```ts
import { reviewPrompt } from "../core/prompt.js";
import { captureDiff } from "../git/diff.js";
```

Remove the entire:

```ts
async review(base: string = "HEAD"): Promise<AcpBridgeResult> {
  ...
}
```

Keep the existing `run(task: string)` ACP lifecycle unchanged.

- [ ] **Step 4: Verify accidental code is gone**

Run:

```bash
rg -n "mimoReviewAcp|AcpBridge\\.review|async review\\(" src/codex/tools.ts src/mimo/acp-bridge.ts
```

Expected:

```text
No matches
```

---

## Task 4: Keep Plugin Skill Docs And Cache Refresh Explicit

**Files:**
- Modify: `skills/mimocode/SKILL.md`
- Modify: `.codex-plugin/plugin.json` only if a cachebuster/version bump is needed.

- [ ] **Step 1: Verify workspace skill docs include all workflow names**

Run:

```bash
rg -n "brainstorm\\|dev\\|fix\\|fix-ci\\|plan\\|execute-plan\\|review\\|parallel\\|worktree\\|merge\\|new-skill" skills/mimocode/SKILL.md
```

Expected:

```text
skills/mimocode/SKILL.md:<line>:  "workflow": "brainstorm|dev|fix|fix-ci|plan|execute-plan|review|parallel|worktree|merge|new-skill",
```

- [ ] **Step 2: If Codex app cache remains stale, bump plugin version**

If the installed cache still shows the old seven-workflow list after reinstall/restart, update `.codex-plugin/plugin.json`:

```json
"version": "0.1.0+codex.20260622readonlyfix"
```

Use the existing project plugin reinstall/cachebuster flow if available. Do not edit `C:/Users/Administrator/.codex/plugins/cache/...` directly as the source of truth.

- [ ] **Step 3: Verify Codex app cache after reinstall**

After reinstall/restart, inspect:

```text
C:/Users/Administrator/.codex/plugins/cache/personal/codex-mimocode/<new-version>/skills/mimocode/SKILL.md
```

Expected:

```text
workflow: "brainstorm|dev|fix|fix-ci|plan|execute-plan|review|parallel|worktree|merge|new-skill"
```

---

## Task 5: Verification Matrix

**Files:**
- No additional source files unless tests require small fixes.

- [ ] **Step 1: Run focused tests**

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

- [ ] **Step 3: Run real Codex MCP dry-run smoke**

From Codex app MCP tools, call:

```json
{
  "cwd": "E:\\ideaProjects\\codex-mimo",
  "workflow": "brainstorm",
  "task": "Clarify the real Codex MCP smoke test requirements.",
  "dryRun": true
}
```

Expected:

```text
status: needs_review
changedFiles: []
eventSummary.messages: 0
reportPaths present
```

- [ ] **Step 4: Run real Codex MCP read-only non-dry-run smoke**

From Codex app MCP tools, call:

```json
{
  "cwd": "E:\\ideaProjects\\codex-mimo",
  "workflow": "brainstorm",
  "task": "Clarify whether this read-only workflow can modify files.",
  "dryRun": false
}
```

Expected if MiMoCode does not edit:

```text
status: passed or needs_review
changedFiles: []
```

Expected if MiMoCode attempts to edit:

```text
status: failed
error contains "Read-only workflow brainstorm modified files"
changedFiles lists the violating files
diffPath is present
```

This second result is acceptable because the bridge correctly detects and reports the violation.

- [ ] **Step 5: Run semantic failure unit coverage**

The unit test from Task 2 must prove that an empty-objective response is failed even when verification passes.

Expected:

```text
status: failed
error contains "MiMoCode did not receive or accept the task objective"
```

---

## Acceptance Criteria

- `brainstorm` and `plan` remain read-only by workflow definition.
- A read-only workflow that changes files returns `status: failed`.
- A read-only workflow violation report includes `changedFiles`, `diffStat`, optional `diffPath`, and compact `reportPaths`.
- A MiMoCode empty-objective/clarification response cannot return `status: passed`.
- `compactComposeReportForCodex()` remains the MCP boundary and does not inline full events, raw logs, full diffs, or `mimoArgs`.
- Accidental `mimoReviewAcp()` and `AcpBridge.review()` additions are removed unless explicitly reintroduced by a separate, tested plan.
- Workspace `skills/mimocode/SKILL.md` documents all 11 workflow names and all 13 official Compose skills.
- If the Codex app installed cache is stale, plugin reinstall/cachebuster steps refresh it.
- `npm run build`, `npm run lint`, and `npm test` pass.

