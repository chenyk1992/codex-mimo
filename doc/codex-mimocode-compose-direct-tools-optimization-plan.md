# Codex MiMoCode Compose and Direct Tools Optimization Plan

> **For MiMo Code / agentic workers:** Execute this plan task-by-task. Use test-first changes where possible. Do not broaden scope into ACP, plugin installation, or unrelated refactors.

**Goal:** Fix the remaining Codex app failures where `mimo_plan`, `mimo_implement`, and some Compose planning flows do not consume the supplied task, while making the Compose integration accurately support the official MiMo Code Compose skill model.

**Architecture:** Keep Codex as the lightweight manager, dispatcher, and acceptance reviewer. Keep MiMo Code as the code-heavy executor. Preserve compact MCP responses for Compose: full JSON events and logs must remain persisted under `.codex-mimo/` and linked through `reportPaths`, not returned inline to Codex.

**Tech Stack:** TypeScript, NodeNext ESM, Vitest, execa v9, Model Context Protocol SDK, MiMoCode CLI JSONL output, Codex plugin MCP tools.

---

## Background

This repository is a Codex-to-MiMoCode bridge. It exposes MCP tools such as `mimo_plan`, `mimo_implement`, `mimo_fix_ci`, `mimo_resume`, and `mimo_compose`.

Prior optimization in Codex thread `019eeaa9-e1f2-7a53-99f4-84d1d9ff534b` established the core product direction:

- Codex owns requirements clarification, planning, task slicing, dispatch, and acceptance review.
- MiMoCode owns codebase-heavy implementation, debugging, validation, and review work.
- Codex should receive compact summaries, not raw long event streams, large diffs, or long stdout logs.
- `mimo_compose` must return compact data only; full reports remain on disk through `reportPaths`.

Do not violate that direction while fixing the remaining tool failures.

## Current Verified Status

After Codex app restart and smoke testing:

| Tool | Current result | Status |
| --- | --- | --- |
| `mimo_healthcheck` | Returns `ok: true`, version `0.1.1` | Passing |
| `mimo_plan` | Still replies as if no task was provided | Failing |
| `mimo_implement` | Still replies as if no task was provided | Failing |
| `mimo_resume` | Edits fixture and returns changed file | Passing |
| `mimo_fix_ci` | Reads attached CI log, fixes `sum.ts`, returns changed file | Passing |
| `mimo_review` | No longer hardcodes empty `findings`, but needs a tracked-diff scenario for stronger validation | Partial |
| `mimo_compose` dry-run | Returns compact report | Passing |
| `mimo_compose` real `plan` | Completes without timeout, but Compose plan still asks for planning input | Partial/failing semantically |

Important smoke-test evidence:

```text
mimo_plan:
I see plan mode is active, but I don't see an actual task description. What would you like me to plan?
```

```text
mimo_implement:
What task would you like me to help with?
```

```text
mimo_fix_ci:
Changed .codex-mimo/plugin-smoke/sum.ts from a - b to a + b and returned changedFiles.
```

```text
mimo_compose workflow=plan:
The run completes and returns compact status, but report events contain:
"Before I can write a plan, I need to know what to plan."
```

## Hard Constraints

Do not break these constraints:

- Keep `mimo_compose` compact MCP responses. Do not return full `events`, `mimoArgs`, long stdout, full diff, or raw logs inline.
- Keep `reportPaths` as the handoff boundary for full JSON, Markdown, event logs, and optional diff files.
- Keep `mimo_fix_ci` and `mimo_resume` behavior that already passed smoke testing.
- Do not remove `--` message separation in `buildMimoRunArgs()` unless a test proves a better compatible form.
- Do not call `--dangerously-skip-permissions`.
- Do not add broad ACP changes.
- Do not clean unrelated dirty or untracked files.
- Do not edit `doc/plugin-test-cases.md` as part of this plan; it has encoding issues and is outside this fix.

## Official Compose Skill Requirement

MiMo Code Compose is a built-in main agent named `compose`. It uses a library of 13 focused skills under the `compose:` namespace. The integration must model these skills accurately.

### Required 13 Skills

Testing:
- `compose:tdd`

Debugging:
- `compose:debug`
- `compose:verify`

Collaboration:
- `compose:brainstorm`
- `compose:plan`
- `compose:execute`
- `compose:parallel`
- `compose:review`
- `compose:feedback`
- `compose:worktree`
- `compose:merge`
- `compose:subagent`

Meta-development:
- `compose:new-skill`

The current `src/compose/workflow.ts` covers only 10 of the 13 skills. Missing skills:

- `compose:worktree`
- `compose:merge`
- `compose:new-skill`

It also defines `plan` as `compose:brainstorm -> compose:plan`, which conflicts with the behavior of `compose:plan`: the plan skill expects an existing spec or requirement and may ask for one if the prompt looks like a brainstorming request. This is the likely reason the real Compose plan run asks what to plan.

## Target Design

### Workflow Model

Update `src/compose/workflow.ts` so workflows map cleanly to official Compose skills.

Required workflow names:

```ts
export type ComposeWorkflowName =
  | "brainstorm"
  | "dev"
  | "fix"
  | "fix-ci"
  | "plan"
  | "execute-plan"
  | "review"
  | "parallel"
  | "worktree"
  | "merge"
  | "new-skill";
```

Recommended workflow definitions:

| Workflow | Skill chain | Writes | Requires task | Requires file | Use |
| --- | --- | --- | --- | --- | --- |
| `brainstorm` | `compose:brainstorm` | false | true | false | Clarify fuzzy requirements |
| `dev` | `compose:brainstorm -> compose:plan -> compose:tdd -> compose:verify -> compose:review` | true | true | false | Feature development loop |
| `fix` | `compose:debug -> compose:tdd -> compose:verify -> compose:feedback` | true | true | false | Bug fix loop |
| `fix-ci` | `compose:debug -> compose:tdd -> compose:verify -> compose:review` | true | false | true | CI failure repair from a log |
| `plan` | `compose:plan` | false | true | false | Write implementation plan from an already clear requirement |
| `execute-plan` | `compose:execute -> compose:tdd -> compose:verify -> compose:review` | true | false | true | Execute an approved plan file |
| `review` | `compose:review -> compose:feedback` | false | false | false | Review current diff |
| `parallel` | `compose:parallel -> compose:subagent -> compose:verify` | true | true | false | Explore independent subtasks |
| `worktree` | `compose:worktree` | true | true | false | Isolate work in a git worktree |
| `merge` | `compose:merge` | true | true | false | Finish or merge a development branch |
| `new-skill` | `compose:new-skill` | true | true | false | Create or update a Compose skill |

### Compose Prompt Strategy

`buildComposePrompt()` should stop framing tasks as a request to "use @compose to run the workflow" followed by ambiguous task text. Compose is already selected by `--agent compose`; prompt it as an objective.

Target structure:

```text
Objective:
<task or workflow default>

Workflow:
<workflow.name> - <workflow.description>

Use these Compose skills in order:
<skill chain>

Instructions:
- Treat the Objective above as the task input for this workflow.
- Do not ask what to plan or implement unless the Objective is genuinely ambiguous.
- Keep changes minimal and focused.
- Do not commit, push, reset, or delete files.
- Record actions taken, verification evidence, and remaining risks.

Read-only constraint:
This workflow is read-only. Do not modify files.
```

For `plan`, include this specific line:

```text
The Objective above is the requirement/spec for compose:plan. Produce a plan from it; do not ask for a separate spec unless it is genuinely missing critical information.
```

For `brainstorm`, allow questions:

```text
Use compose:brainstorm to clarify the Objective. Ask concise questions only when needed.
```

For `fix-ci`, include the attached file line:

```text
Attached/reference file:
@<file>
```

### Direct Tool Strategy

`mimo_plan` and `mimo_implement` should remain available, but they are compatibility tools. They must still try to consume the task.

Update `planPrompt()` and `implementPrompt()` to use a direct objective format:

```text
Objective:
<task>

Execute this objective now. Do not ask what the task is; the Objective above is the task.
```

Rules may follow after the objective, but the user task must be at the top.

Do not make direct tools return large data. Continue returning compact `summary`, `changedFiles`, `commands` / `verification`, and `risks`.

## Files To Modify

Production:
- `src/compose/workflow.ts`
- `src/codex/tool-schemas.ts`
- `src/core/prompt.ts`
- `skills/mimocode/SKILL.md`
- `doc/compose-workflows.md`

Likely no changes needed:
- `src/codex/compact.ts`
- `src/codex/tools.ts`, unless schema/type changes require imports or return adaptation
- `src/mimo/run-json.ts`, unless tests prove the `--` form must change
- `src/mimo/mimo-runner.ts`, unless additional event parsing is needed

Tests:
- `test/unit/compose-workflow.test.ts`
- `test/unit/compose-cli-args.test.ts`
- `test/unit/cli.test.ts`
- Add `test/unit/tool-schemas.test.ts` if schema coverage does not already exist

## Task 1: Add Workflow Coverage Tests

**Goal:** Prove workflow definitions cover all official Compose skills and fix the semantic mismatch in `plan`.

**Files:**
- Modify: `test/unit/compose-workflow.test.ts`
- Modify: `src/compose/workflow.ts`

### Step 1.1: Add failing tests

Add tests similar to:

```ts
import { describe, expect, it } from "vitest";
import { getComposeWorkflow, listComposeWorkflows } from "../../src/compose/workflow.js";

describe("compose workflow official skill coverage", () => {
  it("covers all official MiMo Code Compose skills", () => {
    const usedSkills = new Set(listComposeWorkflows().flatMap((workflow) => workflow.skillChain));

    expect([...usedSkills].sort()).toEqual([
      "compose:brainstorm",
      "compose:debug",
      "compose:execute",
      "compose:feedback",
      "compose:merge",
      "compose:new-skill",
      "compose:parallel",
      "compose:plan",
      "compose:review",
      "compose:subagent",
      "compose:tdd",
      "compose:verify",
      "compose:worktree"
    ]);
  });

  it("keeps plan focused on compose:plan only", () => {
    expect(getComposeWorkflow("plan").skillChain).toEqual(["compose:plan"]);
  });

  it("adds explicit workflows for brainstorm, worktree, merge, and new-skill", () => {
    expect(getComposeWorkflow("brainstorm").skillChain).toEqual(["compose:brainstorm"]);
    expect(getComposeWorkflow("worktree").skillChain).toEqual(["compose:worktree"]);
    expect(getComposeWorkflow("merge").skillChain).toEqual(["compose:merge"]);
    expect(getComposeWorkflow("new-skill").skillChain).toEqual(["compose:new-skill"]);
  });
});
```

### Step 1.2: Run the test and verify RED

Run:

```powershell
npm test -- compose-workflow.test.ts
```

Expected before implementation:

```text
FAIL
```

The failure should mention unknown workflows or missing skills.

### Step 1.3: Implement workflow updates

Update `ComposeWorkflowName` and `workflows` in `src/compose/workflow.ts` according to the Target Design table.

### Step 1.4: Run the test and verify GREEN

Run:

```powershell
npm test -- compose-workflow.test.ts
```

Expected:

```text
PASS test/unit/compose-workflow.test.ts
```

## Task 2: Fix Compose Prompt Semantics

**Goal:** Stop Compose plan from asking "what should I plan?" when `task` was already supplied.

**Files:**
- Modify: `src/compose/workflow.ts`
- Modify: `test/unit/compose-workflow.test.ts`

### Step 2.1: Add failing prompt tests

Add tests:

```ts
import { buildComposePrompt, getComposeWorkflow } from "../../src/compose/workflow.js";

it("puts the objective first in compose prompts", () => {
  const prompt = buildComposePrompt({
    workflow: getComposeWorkflow("plan"),
    task: "Fix .codex-mimo/plugin-smoke/sum.ts so it returns a + b."
  });

  expect(prompt.startsWith("Objective:\nFix .codex-mimo/plugin-smoke/sum.ts")).toBe(true);
});

it("tells compose:plan to treat the objective as the requirement", () => {
  const prompt = buildComposePrompt({
    workflow: getComposeWorkflow("plan"),
    task: "Write an implementation plan for the smoke fixture."
  });

  expect(prompt).toContain("The Objective above is the requirement/spec for compose:plan.");
  expect(prompt).toContain("do not ask for a separate spec");
});

it("does not forbid questions for brainstorm workflow", () => {
  const prompt = buildComposePrompt({
    workflow: getComposeWorkflow("brainstorm"),
    task: "Clarify a new feature idea."
  });

  expect(prompt).toContain("Use compose:brainstorm to clarify the Objective.");
});
```

### Step 2.2: Run RED

Run:

```powershell
npm test -- compose-workflow.test.ts
```

Expected:

```text
FAIL
```

### Step 2.3: Implement prompt changes

Replace the existing `buildComposePrompt()` string structure with the Target Design prompt.

Keep existing behavior:
- Include attached file reference when `file` is present.
- Include `since` when present.
- Include read-only constraint when `writesAllowed` is false.

### Step 2.4: Run GREEN

Run:

```powershell
npm test -- compose-workflow.test.ts
```

Expected:

```text
PASS
```

## Task 3: Extend MCP Schema For New Workflows

**Goal:** Allow Codex app MCP calls to pass the new workflow names.

**Files:**
- Modify: `src/codex/tool-schemas.ts`
- Add or modify: `test/unit/tool-schemas.test.ts`

### Step 3.1: Add schema test

Create `test/unit/tool-schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ComposeInput } from "../../src/codex/tool-schemas.js";

describe("tool schemas", () => {
  it("accepts all supported compose workflows", () => {
    for (const workflow of [
      "brainstorm",
      "dev",
      "fix",
      "fix-ci",
      "plan",
      "execute-plan",
      "review",
      "parallel",
      "worktree",
      "merge",
      "new-skill"
    ]) {
      expect(() => ComposeInput.parse({ cwd: "E:/project/app", workflow, task: "Test task" })).not.toThrow();
    }
  });
});
```

### Step 3.2: Run RED

Run:

```powershell
npm test -- tool-schemas.test.ts
```

Expected:

```text
FAIL
```

### Step 3.3: Update schema

Update `ComposeInput.workflow` in `src/codex/tool-schemas.ts` to include:

```ts
z.enum([
  "brainstorm",
  "dev",
  "fix",
  "fix-ci",
  "plan",
  "execute-plan",
  "review",
  "parallel",
  "worktree",
  "merge",
  "new-skill"
])
```

### Step 3.4: Run GREEN

Run:

```powershell
npm test -- tool-schemas.test.ts
```

Expected:

```text
PASS
```

## Task 4: Improve Direct Tool Prompts Without Breaking Compact Design

**Goal:** Make `mimo_plan` and `mimo_implement` more likely to consume tasks while keeping them lightweight compatibility tools.

**Files:**
- Modify: `src/core/prompt.ts`
- Modify: `test/unit/cli.test.ts`

### Step 4.1: Add prompt tests

Add or update tests:

```ts
it("plan prompt starts with an explicit objective", () => {
  const prompt = planPrompt("Fix sum.ts");

  expect(prompt.startsWith("Objective:\nFix sum.ts")).toBe(true);
  expect(prompt).toContain("Do not ask what the task is");
});

it("implement prompt starts with an explicit objective", () => {
  const prompt = implementPrompt("Update README");

  expect(prompt.startsWith("Objective:\nUpdate README")).toBe(true);
  expect(prompt).toContain("Do not ask what the task is");
});
```

### Step 4.2: Run RED

Run:

```powershell
npm test -- cli.test.ts
```

Expected:

```text
FAIL
```

### Step 4.3: Update prompts

Update `planPrompt()` and `implementPrompt()` to start with:

```text
Objective:
<task>

Execute this objective now. Do not ask what the task is; the Objective above is the task.
```

Keep existing rules after that.

### Step 4.4: Run GREEN

Run:

```powershell
npm test -- cli.test.ts
```

Expected:

```text
PASS
```

## Task 5: Update Documentation And Skill Guidance

**Goal:** Make docs match official Compose semantics and the lightweight Codex delegation model.

**Files:**
- Modify: `skills/mimocode/SKILL.md`
- Modify: `doc/compose-workflows.md`

### Step 5.1: Update `skills/mimocode/SKILL.md`

Required changes:

- In the `mimo_compose` input example, include all workflow names:

```text
brainstorm|dev|fix|fix-ci|plan|execute-plan|review|parallel|worktree|merge|new-skill
```

- Replace current supported workflow list with the Target Design table or concise bullets.
- Add a "Compose Skill Library" section listing all 13 official skills.
- Explain:
  - Use `brainstorm` when requirements are unclear.
  - Use `plan` only when the task/requirement is already clear.
  - Use `execute-plan` when an approved plan file exists.
  - Use `new-skill` only for Compose skill authoring.
  - Use `worktree` and `merge` only for explicit git workflow tasks.
- Preserve the Context Budget Rules from thread `019eeaa9-e1f2-7a53-99f4-84d1d9ff534b`.

### Step 5.2: Update `doc/compose-workflows.md`

Replace the workflow table with the new workflow table from Target Design.

Add a "Official Skill Coverage" section listing all 13 skills.

Add a note:

```text
The `plan` workflow intentionally uses only `compose:plan`. Use `brainstorm` before `plan` when requirements are still unclear.
```

### Step 5.3: Manual doc verification

Run:

```powershell
rg -n "brainstorm|worktree|merge|new-skill|compose:new-skill|compose:worktree|compose:merge" skills/mimocode/SKILL.md doc/compose-workflows.md
```

Expected:

```text
Matches are present in both files.
```

## Task 6: Full Verification

### Step 6.1: Run focused tests

Run:

```powershell
npm test -- compose-workflow.test.ts tool-schemas.test.ts cli.test.ts run-json.test.ts codex-compact.test.ts mimo-runner.test.ts
```

Expected:

```text
PASS
```

If sandbox blocks Vitest with `spawn EPERM`, rerun in an environment that permits child process spawning.

### Step 6.2: Run full test suite

Run:

```powershell
npm test
```

Expected:

```text
All test files pass.
```

### Step 6.3: Run build

Run:

```powershell
npm run build
```

Expected:

```text
tsc -p tsconfig.json
```

with exit code `0`.

### Step 6.4: Validate compact behavior remains intact

Run:

```powershell
npm test -- codex-compact.test.ts
```

Expected:

```text
PASS
```

Also inspect `src/codex/tools.ts` and confirm:

```ts
const report = await runComposeWorkflow(parsed);
return compactComposeReportForCodex(report);
```

## Task 7: Codex App Smoke Test Matrix

After building and restarting Codex app or starting a fresh thread, run these MCP smoke tests.

### 7.1 Healthcheck

Input:

```json
{ "cwd": "E:\\ideaProjects\\codex-mimo" }
```

Expected:

```json
{ "ok": true, "version": "0.1.1" }
```

### 7.2 Compose Plan

Input:

```json
{
  "cwd": "E:\\ideaProjects\\codex-mimo",
  "workflow": "plan",
  "task": "Inspect only .codex-mimo/plugin-smoke and write a short read-only plan explaining that sum.ts should return a + b. Do not modify files."
}
```

Expected:
- Returns compact response.
- Does not timeout.
- Does not ask "what should I plan?"
- Report event log contains a plan or an explicit analysis of `.codex-mimo/plugin-smoke/sum.ts`.

### 7.3 Compose Brainstorm

Input:

```json
{
  "cwd": "E:\\ideaProjects\\codex-mimo",
  "workflow": "brainstorm",
  "task": "Clarify how to improve the smoke fixture validation workflow."
}
```

Expected:
- Uses `compose:brainstorm`.
- May ask clarification questions.
- Does not write files.

### 7.4 Compose Fix-CI

Input:

```json
{
  "cwd": "E:\\ideaProjects\\codex-mimo",
  "workflow": "fix-ci",
  "file": "E:\\ideaProjects\\codex-mimo\\.codex-mimo\\plugin-smoke\\ci.log",
  "task": "Use only .codex-mimo/plugin-smoke. Fix sum.ts so the attached CI failure would pass."
}
```

Expected:
- Fixes `sum.ts` to return `a + b`.
- Returns compact response.
- Reports changed file.

### 7.5 Direct Plan Compatibility

Input:

```json
{
  "cwd": "E:\\ideaProjects\\codex-mimo",
  "task": "Inspect only .codex-mimo/plugin-smoke and produce a concise read-only plan to fix sum.ts so it returns a + b."
}
```

Expected:
- Preferably returns a plan.
- Must not regress existing successful tools if it still asks for a task.
- If still unreliable, document direct `mimo_plan` as compatibility-only and recommend `mimo_compose workflow=plan`.

### 7.6 Direct Implement Compatibility

Input:

```json
{
  "cwd": "E:\\ideaProjects\\codex-mimo",
  "task": "Only edit .codex-mimo/plugin-smoke/README.md. Append a final line exactly: - Smoke implement path verified.",
  "allowWrite": true
}
```

Expected:
- Preferably edits README and returns changed file.
- If still unreliable, document direct `mimo_implement` as compatibility-only and recommend `mimo_compose workflow=fix/dev/execute-plan`.

## Acceptance Criteria

This plan is complete when all of the following are true:

- `src/compose/workflow.ts` supports workflows that cover all 13 official Compose skills.
- `plan` workflow uses `compose:plan` only.
- `brainstorm`, `worktree`, `merge`, and `new-skill` workflows are available through schema and workflow resolution.
- `mimo_compose workflow=plan` no longer asks for a separate task/spec when a clear `task` is provided.
- `mimo_compose` responses remain compact and do not include full events or long command logs.
- Existing passing behavior for `mimo_fix_ci` and `mimo_resume` remains passing.
- `npm test` passes in an environment where Vitest can spawn child processes.
- `npm run build` passes.
- `skills/mimocode/SKILL.md` and `doc/compose-workflows.md` document all supported Compose workflows and 13 skills.

## Known Risks

- Direct `mimo_plan` and `mimo_implement` may still be less reliable than Compose because MiMoCode's `plan` and `build` agents can enter an interactive clarification mode. If prompt changes do not fix them, keep them as compatibility tools and steer users toward Compose.
- Running real MiMoCode CLI calls may send prompt/context to the configured MiMo service. Do not run broad probes without user approval.
- `.codex-mimo/plugin-smoke` is gitignored, so git diff fallback may not detect every fixture change. Rely on MiMo JSONL `edit/write` parsing for ignored smoke fixtures.
- Current Windows sandbox may block Vitest startup with `spawn EPERM`; use an approved environment for final test execution.

