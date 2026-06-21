# Codex MiMoCode Plugin Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all defects found during the Codex app smoke test of the `codex-mimocode:mimocode` plugin so each exposed MCP tool can execute its documented function reliably.

**Architecture:** Keep the repair focused on the MCP tool layer, MiMo CLI argument construction, MiMo JSONL result parsing, and Compose report generation. Add unit tests first for each failing behavior, then make the smallest production changes needed to satisfy those tests and the Codex app smoke-test acceptance criteria.

**Tech Stack:** TypeScript, NodeNext ESM, Vitest, execa v9, Model Context Protocol SDK, MiMoCode CLI JSONL output.

---

## Scope

This plan covers the issues observed by directly testing the installed `codex-mimocode` plugin from Codex app:

| Tool | Observed result | Target result |
| --- | --- | --- |
| `mimo_healthcheck` | Passed | Keep passing |
| `mimo_plan` | Callable, but task prompt was not consumed by MiMoCode | MiMoCode receives and acts on the task |
| `mimo_implement` | Callable, but task prompt was not consumed by MiMoCode | MiMoCode receives and acts on the task |
| `mimo_review` | Review text returned, but `findings` is always `[]` | Return useful structured findings or remove the misleading field contract |
| `mimo_resume` | File was changed, but `changedFiles` returned `[]` | Return changed files from MiMo JSONL output and/or git diff fallback |
| `mimo_fix_ci` | Failed with `File not found: You are being invoked...` | Attached CI log is passed as a file and task prompt remains a positional message |
| `mimo_compose` | Dry-run worked; real workflow failed with `require is not defined` | Real Compose workflows run and write reports under ESM |

Out of scope:
- Changing the MiMoCode CLI itself.
- Broad refactors of the ACP bridge.
- Rewriting the plugin manifest or marketplace metadata.
- Cleaning unrelated dirty worktree files.

## Existing Evidence

Smoke-test fixture used:
- `.codex-mimo/plugin-smoke/README.md`
- `.codex-mimo/plugin-smoke/sum.ts`
- `.codex-mimo/plugin-smoke/sum.test.ts`
- `.codex-mimo/plugin-smoke/ci.log`

Important observed outputs:

```text
mimo_healthcheck:
{"ok":true,"version":"0.1.1","cwd":"E:\\ideaProjects\\codex-mimo"}
```

```text
mimo_plan:
"I'm ready to plan. What task would you like me to work on?"
```

```text
mimo_implement:
"Ready. What task should I implement?"
```

```text
mimo_fix_ci:
Command failed with exit code 1: mimo run --format json --agent build --file "...\\ci.log" "You are being invoked..."
Error: File not found: You are being invoked by Codex as a specialist MiMoCode implementation agent.
```

```text
mimo_compose real review workflow:
require is not defined
```

## Files To Modify

Production files:
- `src/mimo/run-json.ts`: Build MiMo CLI arguments in an order accepted by MiMoCode when `--file` and message are both present.
- `src/mimo/mimo-runner.ts`: Parse MiMo JSONL output more robustly, preserve errors, recognize session ID variants, changed file events, and command results.
- `src/codex/tools.ts`: Use the fixed runner contract, improve review findings behavior, and optionally add git-diff fallback for changed files.
- `src/compose/runner.ts`: Remove CommonJS `require()` from ESM code.
- `src/compose/report.ts`: No required change expected, but keep available if report contract tests need small updates.
- `skills/mimocode/SKILL.md`: Document `mimo_compose` and the repaired return contracts.
- `doc/plugin-test-cases.md`: Optional follow-up only if encoding is repaired separately; do not edit as part of this plan unless explicitly requested.

Test files:
- `test/unit/run-json.test.ts`: Cover argument order for `--file` plus message.
- `test/unit/mimo-runner.test.ts`: Add focused tests for JSONL parsing behavior.
- `test/unit/tools.test.ts`: Add MCP tool handler tests with mocked runner/execa where practical.
- `test/unit/compose-runner.test.ts`: Add a regression test that exercises diff writing under ESM.

## Problem 1: `mimo_plan` and `mimo_implement` Do Not Consume Task Prompts

### Cause

The MCP handlers pass the generated prompt as the final positional argument:

```ts
args.push(options.message);
```

This works for some MiMo invocations but the Codex app smoke test showed that `mimo_plan` and `mimo_implement` entered an interactive waiting state instead of acting on the provided task. The most likely causes are:
- MiMoCode CLI expects the message before some flags, or expects an explicit prompt/message flag in the installed CLI version.
- The runner parses only `stdout`, so if MiMo reports prompt/argument interpretation details on `stderr`, current tooling hides that context.
- Current tests assert the existing argument order instead of validating the behavior required by the real CLI.

### Reproduction

From Codex app MCP tool call:

```json
{
  "cwd": "E:\\ideaProjects\\codex-mimo",
  "task": "Inspect .codex-mimo/plugin-smoke and produce a minimal fix plan."
}
```

Expected current failure:

```text
I'm ready to plan. What task would you like me to work on?
```

For implementation:

```json
{
  "cwd": "E:\\ideaProjects\\codex-mimo",
  "task": "Only edit .codex-mimo/plugin-smoke/README.md by appending one line.",
  "allowWrite": true
}
```

Expected current failure:

```text
Ready. What task should I implement?
```

### Solution

1. Characterize MiMo CLI argument behavior locally with the smallest safe dry commands:

```powershell
mimo run --format json --agent plan "Plan a no-op task"
mimo run "Plan a no-op task" --format json --agent plan
mimo run --help
```

2. Update `buildMimoRunArgs()` to match the accepted MiMoCode CLI syntax.

3. Keep `stdin: "ignore"` in `runAndCapture()` so MiMo never waits for inherited stdin.

4. Add a regression test that documents the accepted argument layout.

### Implementation Tasks

- [ ] Add or update `test/unit/run-json.test.ts` with the verified MiMo argument order.
- [ ] Update `src/mimo/run-json.ts` to generate that argument order.
- [ ] Run the specific test:

```powershell
npm test -- run-json.test.ts
```

Expected:

```text
PASS test/unit/run-json.test.ts
```

- [ ] Re-run `mimo_plan` from Codex app with a fixture task.
- [ ] Re-run `mimo_implement` from Codex app against `.codex-mimo/plugin-smoke/README.md`.

### Acceptance Criteria

- `mimo_plan` returns a plan that references the provided task and fixture path.
- `mimo_implement` makes the requested fixture-only edit.
- Neither command asks "What task would you like me to work on?"
- `npm test -- run-json.test.ts` passes.
- `npm run build` passes.

## Problem 2: `mimo_fix_ci` Treats Prompt Text As A File Path

### Cause

`mimo_fix_ci` calls `runAndCapture()` with both:

```ts
message: implementPrompt(...)
files: [parsed.file]
```

`buildMimoRunArgs()` currently emits:

```text
mimo run --format json --agent build --file <ci.log> <message>
```

The real MiMoCode CLI interpreted the following message as another file path, producing:

```text
File not found: You are being invoked by Codex as a specialist MiMoCode implementation agent.
```

This strongly suggests the CLI consumes positional values after `--file` differently than the tests assume, or requires message placement before file flags.

### Reproduction

Use the smoke CI log:

```json
{
  "cwd": "E:\\ideaProjects\\codex-mimo",
  "file": "E:\\ideaProjects\\codex-mimo\\.codex-mimo\\plugin-smoke\\ci.log",
  "task": "Fix the broken sum implementation shown in the CI log."
}
```

Expected current failure:

```text
File not found: You are being invoked by Codex as a specialist MiMoCode implementation agent.
```

### Solution

Use the same CLI argument characterization from Problem 1, then adjust `buildMimoRunArgs()` so:
- The message is unambiguously passed as the task prompt.
- `--file <path>` is unambiguously passed as an attachment.
- The order works for plan, implement, fix-ci, and compose.

If MiMo CLI supports a named prompt flag, prefer it over positional ambiguity. If no named flag exists, use the empirically accepted positional order and document it in tests.

### Implementation Tasks

- [ ] Add a `run-json.test.ts` case for `files` plus `message` that matches the verified CLI syntax.
- [ ] Add a `tools.test.ts` case for `mimoFixCi()` that asserts the runner receives `files: [parsed.file]` and the implementation prompt remains the message.
- [ ] Update `src/mimo/run-json.ts`.
- [ ] Run:

```powershell
npm test -- run-json.test.ts
```

Expected:

```text
PASS test/unit/run-json.test.ts
```

- [ ] Re-run `mimo_fix_ci` against `.codex-mimo/plugin-smoke/ci.log`.

### Acceptance Criteria

- `mimo_fix_ci` no longer reports `File not found` for prompt text.
- `mimo_fix_ci` edits only `.codex-mimo/plugin-smoke/sum.ts` in the smoke fixture.
- The fixture implementation changes from subtraction to addition:

```ts
export function sum(a: number, b: number): number {
  return a + b;
}
```

- Narrow verification passes:

```powershell
npm test -- .codex-mimo/plugin-smoke/sum.test.ts
```

If Vitest does not include `.codex-mimo` tests by config, use this acceptance command instead:

```powershell
npm test -- run-json.test.ts
```

and manually confirm the fixture diff.

## Problem 3: `mimo_compose` Real Workflows Fail With `require is not defined`

### Cause

`src/compose/runner.ts` is compiled as ESM because `package.json` has:

```json
"type": "module"
```

But `buildReport()` uses CommonJS `require()`:

```ts
const fs = require("node:fs");
fs.mkdirSync(input.diffsDir, { recursive: true });
fs.writeFileSync(diffPath, input.diff.diff, "utf-8");
```

When a real Compose workflow produces a diff, Node executes this code in ESM mode and throws:

```text
require is not defined
```

### Reproduction

Run a non-dry Compose workflow that reaches diff writing:

```json
{
  "cwd": "E:\\ideaProjects\\codex-mimo",
  "workflow": "review",
  "since": "HEAD",
  "task": "Review current uncommitted changes. Do not modify files."
}
```

Expected current failure:

```text
require is not defined
```

### Solution

Replace `require("node:fs")` with an ESM import:

```ts
import fs from "node:fs";
```

Then use the imported `fs` inside `buildReport()`.

### Implementation Tasks

- [ ] Add a regression test in `test/unit/compose-runner.test.ts` that supplies a non-empty `diff.diff` and lets the default diff-file writing path run.
- [ ] Update `src/compose/runner.ts` with `import fs from "node:fs";`.
- [ ] Remove the local `require()` call.
- [ ] Run:

```powershell
npm test -- compose-runner.test.ts
```

Expected:

```text
PASS test/unit/compose-runner.test.ts
```

- [ ] Run:

```powershell
npm run build
```

Expected:

```text
tsc -p tsconfig.json
```

with exit code `0`.

### Acceptance Criteria

- `mimo_compose` real workflow no longer returns `require is not defined`.
- Compose writes Markdown, JSON, JSONL, and diff report artifacts when applicable.
- `npm test -- compose-runner.test.ts` passes.
- `npm run build` passes.

## Problem 4: `mimo_review` Always Returns Empty `findings`

### Cause

`src/codex/tools.ts` hardcodes:

```ts
findings: []
```

This discards all review information except unstructured `summary`. During the smoke test, MiMoCode produced a long review, but the structured `findings` field remained empty.

### Reproduction

Create or keep any uncommitted diff, then call:

```json
{
  "cwd": "E:\\ideaProjects\\codex-mimo",
  "base": "HEAD"
}
```

Expected current result:

```json
{
  "summary": "...long review text...",
  "findings": []
}
```

### Solution

Use a minimal, explicit findings contract.

Recommended type:

```ts
export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  file?: string;
  line?: number;
  body: string;
}
```

Implementation options:
- Best: Ask MiMoCode for a strict JSON findings block in `reviewPrompt()` and parse it.
- Minimal: Return one `info` finding containing the review summary when no structured findings can be parsed.

Prefer the best option if MiMoCode reliably follows JSON instructions. Otherwise use the minimal option to avoid a misleading empty array.

### Implementation Tasks

- [ ] Add tests in `test/unit/tools.test.ts` for `mimoReview()` returning non-empty findings when review text exists.
- [ ] Update `reviewPrompt()` in `src/core/prompt.ts` to request concise structured findings.
- [ ] Add a helper in `src/codex/tools.ts` or a small new file such as `src/codex/review-findings.ts` if parsing logic would make `tools.ts` too busy.
- [ ] Ensure `mimoReview()` returns parsed findings or a single fallback finding.
- [ ] Run:

```powershell
npm test -- tools.test.ts
```

Expected:

```text
PASS test/unit/tools.test.ts
```

### Acceptance Criteria

- `mimo_review` does not return `findings: []` when the summary contains review content.
- If no issues are found, `findings` contains an `info` item or the contract is documented clearly as empty when clean.
- The review summary remains available.
- Tests cover both "finding text exists" and "no changes found" behavior.

## Problem 5: `mimo_resume` Changes Files But Returns Empty `changedFiles`

### Cause

`parseMimoOutput()` only records changed files for this narrow event shape:

```ts
if (part.tool === "write" && state) {
  const meta = state.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta.filepath === "string") {
    changedFiles.add(meta.filepath);
  }
}
```

The real MiMo output from `mimo_resume` changed `.codex-mimo/plugin-smoke/README.md`, but did not match this parser shape. The result returned:

```json
"changedFiles": []
```

### Reproduction

Use the session returned by the failed/interactive implement call:

```json
{
  "cwd": "E:\\ideaProjects\\codex-mimo",
  "session": "<session-id>",
  "task": "Only edit .codex-mimo/plugin-smoke/README.md by marking the second item done."
}
```

Expected current behavior:
- File changes on disk.
- `changedFiles` is empty.

### Solution

Improve changed-file capture using two layers:

1. Parse more MiMo JSONL shapes.
2. Add a git diff fallback around tool execution for MCP handlers that may write files.

Parser improvements should inspect common keys such as:
- `filepath`
- `filePath`
- `path`
- `metadata.filepath`
- `metadata.filePath`
- `metadata.path`
- `input.filepath`
- `input.filePath`
- `input.path`

Fallback approach:
- Capture `git diff --name-only HEAD` before and after `mimo_implement`, `mimo_fix_ci`, and `mimo_resume`.
- Return the union of parser-derived changed files and after-minus-before git diff paths.
- Keep fallback best-effort so non-git workspaces still work.

### Implementation Tasks

- [ ] Create `test/unit/mimo-runner.test.ts`.
- [ ] Add parser tests for `sessionID` and `sessionId`.
- [ ] Add parser tests for write events using `metadata.filepath`, `metadata.filePath`, `input.path`, and top-level `path`.
- [ ] Export only what tests need; if `parseMimoOutput()` remains private, test through `runAndCapture()` with mocked execa.
- [ ] Add a small helper for changed-file union if git fallback is implemented.
- [ ] Run:

```powershell
npm test -- mimo-runner.test.ts
```

Expected:

```text
PASS test/unit/mimo-runner.test.ts
```

### Acceptance Criteria

- `mimo_resume` returns `.codex-mimo/plugin-smoke/README.md` in `changedFiles` after editing the smoke fixture.
- `mimo_implement` and `mimo_fix_ci` also return changed files when they write files.
- Existing tool responses keep their current top-level shape.
- Tests cover at least three MiMo JSONL file-path shapes.

## Problem 6: `runAndCapture()` Loses Error Information

### Cause

`parseMimoOutput()` initializes an `errors` array but never appends to it:

```ts
const errors: string[] = [];
```

This means failed MiMo operations may surface as generic execa failures or empty `risks`, reducing diagnosability in Codex app.

### Reproduction

Trigger a failing MiMo command such as the current `mimo_fix_ci` case. The returned MCP error is raw command failure text, and normal result objects do not preserve structured JSONL error events.

### Solution

Parse common error shapes from JSONL:
- `type: "error"` with `message`
- `type: "error"` with `text`
- `level: "error"` with `message`
- tool result metadata with non-zero exit and stderr

Also include `result.stderr` when execa returns non-zero and `reject: false` is used, if the runner changes to tolerate non-zero exits.

### Implementation Tasks

- [ ] Add `mimo-runner.test.ts` cases for JSONL error events.
- [ ] Update `parseMimoOutput()` to populate `errors`.
- [ ] Consider changing `runAndCapture()` to `reject: false` and include an `exitCode` field in `MimoRunResult`.
- [ ] Update MCP handlers to report failures in a structured way.

### Acceptance Criteria

- A JSONL error event appears in `risks` or `errors`.
- Failed tool calls include actionable error text without requiring the user to inspect hidden terminal output.
- Existing successful calls are unchanged.

## Problem 7: `mimo_plan` Ignores `agent` And `model` Inputs

### Cause

`PlanInput` accepts:

```ts
agent: z.string().default("plan"),
model: z.string().optional()
```

But `mimoPlan()` hardcodes:

```ts
agent: "plan"
```

and does not pass `model`.

### Reproduction

Call:

```json
{
  "cwd": "E:\\ideaProjects\\codex-mimo",
  "task": "Plan a no-op change",
  "agent": "codex-reviewer",
  "model": "mimo/mimo-v2.5-pro"
}
```

Current behavior:
- The handler still passes `agent: "plan"`.
- `model` is ignored.

### Solution

Pass parsed options through:

```ts
agent: parsed.agent,
model: parsed.model,
```

### Implementation Tasks

- [ ] Add a `tools.test.ts` case for `mimoPlan()` forwarding `agent` and `model`.
- [ ] Update `src/codex/tools.ts`.
- [ ] Run:

```powershell
npm test -- tools.test.ts
```

### Acceptance Criteria

- `mimo_plan` forwards `agent` and `model` when provided.
- Default behavior remains `agent: "plan"` when not provided.

## Problem 8: Skill Documentation Omits `mimo_compose`

### Cause

The skill file documents:
- `mimo_healthcheck`
- `mimo_plan`
- `mimo_implement`
- `mimo_review`
- `mimo_fix_ci`
- `mimo_resume`

But the MCP server exposes `mimo_compose` too.

### Reproduction

Open:

```text
skills/mimocode/SKILL.md
```

Observe that `mimo_compose` is missing from the Available Tools section despite being registered in `src/codex/mcp-server.ts`.

### Solution

Add a `mimo_compose` section to `skills/mimocode/SKILL.md` after `mimo_resume`, including:
- Supported workflows: `dev`, `fix`, `fix-ci`, `plan`, `execute-plan`, `review`, `parallel`.
- Key inputs: `cwd`, `workflow`, `task`, `file`, `since`, `verification`, `dryRun`.
- Safety note: reports are written under `.codex-mimo/reports` and related directories.

### Implementation Tasks

- [ ] Update `skills/mimocode/SKILL.md`.
- [ ] Mention that `mimo_compose` should be used for full workflow orchestration, not for trivial one-shot edits.
- [ ] Run no code tests; docs-only verification is a manual read.

### Acceptance Criteria

- Skill docs list all MCP tools exposed by `src/codex/mcp-server.ts`.
- Input examples match the actual `ComposeInput` schema.
- The recommended workflow distinguishes direct MCP tools from Compose workflows.

## End-To-End Smoke Test Plan

After implementing all fixes, rebuild and reload the plugin in Codex app if needed.

### Setup

Create or reset the disposable fixture:

```powershell
New-Item -ItemType Directory -Force -Path '.codex-mimo/plugin-smoke'
```

Use these files:

```ts
// .codex-mimo/plugin-smoke/sum.ts
export function sum(a: number, b: number): number {
  return a - b;
}
```

```ts
// .codex-mimo/plugin-smoke/sum.test.ts
import { describe, expect, it } from "vitest";
import { sum } from "./sum.js";

describe("sum", () => {
  it("adds two positive numbers", () => {
    expect(sum(2, 3)).toBe(5);
  });
});
```

```text
# .codex-mimo/plugin-smoke/ci.log
FAIL .codex-mimo/plugin-smoke/sum.test.ts > sum > adds two positive numbers
AssertionError: expected -1 to be 5
```

### Tool Acceptance Matrix

| Tool | Call | Acceptance |
| --- | --- | --- |
| `mimo_healthcheck` | `{ "cwd": "E:\\ideaProjects\\codex-mimo" }` | Returns `ok: true` and a version |
| `mimo_plan` | Plan a fixture-only sum fix | Returns a plan mentioning `.codex-mimo/plugin-smoke/sum.ts` |
| `mimo_implement` | Append one README line with `allowWrite: true` | Edits only fixture README and returns changed file |
| `mimo_review` | Review current diff against `HEAD` | Returns summary plus non-misleading findings |
| `mimo_resume` | Continue prior session with a second README edit | Edits fixture README and returns changed file |
| `mimo_fix_ci` | Attach fixture `ci.log` and fix sum | Changes `a - b` to `a + b`; no prompt-as-file error |
| `mimo_compose` | Run `workflow: "review"` against `HEAD` | Completes without `require is not defined` and writes reports |

### Repository Verification

Run:

```powershell
npm test
npm run build
```

Expected:

```text
vitest run
```

with exit code `0`, and:

```text
tsc -p tsconfig.json
```

with exit code `0`.

## Suggested Task Order

1. Fix `mimo_compose` ESM crash first because it is isolated and low risk. ✅
2. Characterize and fix MiMo CLI argument order because it affects `plan`, `implement`, `fix-ci`, and Compose. ✅
3. Improve `runAndCapture()` parsing and changed-file reporting. ✅
4. Repair `mimo_review` findings behavior. ✅
5. Pass through `agent` and `model` in `mimo_plan`. ✅
6. Update skill documentation. ✅
7. Run the full smoke-test matrix in Codex app.

## Completion Checklist

- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] `mimo_healthcheck` passes in Codex app.
- [ ] `mimo_plan` consumes the supplied task.
- [ ] `mimo_implement` consumes the supplied task and writes only requested files.
- [ ] `mimo_review` returns useful review data without hardcoded empty findings.
- [ ] `mimo_resume` reports changed files after writing files.
- [ ] `mimo_fix_ci` handles attached CI logs without prompt/file confusion.
- [ ] `mimo_compose` real workflow completes without ESM runtime errors.
- [ ] `skills/mimocode/SKILL.md` documents all exposed tools.

## Residual Risks

- The exact MiMo CLI argument syntax must be verified against the installed `mimo` version because the current unit tests may encode an invalid assumption.
- Some changed-file detection depends on MiMo JSONL event shapes. Git diff fallback reduces this risk but does not help in non-git directories.
- Review findings parsing may be imperfect if MiMo returns prose. The fallback finding must keep the response honest rather than claiming structured precision.
- Codex app may need plugin reload or rebuild after code changes because MCP tools run from `dist/codex/mcp-server.js`.

