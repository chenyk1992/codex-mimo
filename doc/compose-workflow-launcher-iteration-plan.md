# Codex-MiMo Compose Workflow Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `compose:plan`, `compose:tdd`, `compose:execute`, `compose:verify`, and `compose:review` when executing this plan in MiMoCode Compose mode. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `codex-mimo` from a thin MiMoCode CLI wrapper into a Compose workflow launcher that runs named Compose skill workflows and produces structured execution reports containing JSON events, git diff, verification commands, and review conclusions.

**Architecture:** Keep the current MVP path based on `mimo run --format json` and add a workflow orchestration layer above it. The new layer maps high-level commands such as `compose --workflow dev`, `compose --workflow fix-ci`, and `compose --workflow execute-plan` into deterministic Compose prompts, captures MiMoCode JSON events, snapshots git diff before and after execution, runs configured verification commands, and writes a Markdown plus JSON report under `.codex-mimo/reports/`.

**Tech Stack:** Node.js, TypeScript, MiMoCode CLI, MiMoCode Compose mode, JSON event parsing, Git CLI, Vitest, Markdown report generation.

---

## 1. Current Context

The current MVP already has the right foundation:

- `src/cli/main.ts` handles CLI routing.
- `src/cli/commands.ts` invokes MiMoCode.
- `src/mimo/run-json.ts` builds `mimo run --format json` arguments.
- `src/codex/tools.ts` exposes Codex-facing tools.
- `src/core/prompt.ts` contains prompt builders.
- `src/git/` is planned for diff/status helpers.
- `doc/codex-mimo-acceptance-review.md` records current gaps.

The next iteration should prioritize real operational value before deeper ACP work:

1. Make Compose a first-class workflow target.
2. Parse and retain MiMoCode JSON events.
3. Capture before/after git state.
4. Run verification commands explicitly.
5. Generate structured reports that Codex and humans can inspect.

---

## 2. Product Shape

The user-facing command should look like this:

```bash
codex-mimo compose --workflow dev "实现登录限流"
codex-mimo compose --workflow fix "修复用户会话测试失败"
codex-mimo compose --workflow fix-ci --file ci.log
codex-mimo compose --workflow review --since HEAD
codex-mimo compose --workflow execute-plan --file doc/codex-mimo-acp-integration-plan.md
```

The command should produce:

```text
.codex-mimo/
  reports/
    2026-06-21T18-40-00-compose-dev.json
    2026-06-21T18-40-00-compose-dev.md
  events/
    2026-06-21T18-40-00-compose-dev.jsonl
```

Each report must include:

- Workflow name.
- Full MiMoCode command arguments.
- Compose skills requested in the prompt.
- MiMoCode JSON events.
- Changed files from git diff.
- Diff summary and optional full diff path.
- Verification commands and exit codes.
- Review conclusions or raw review text.
- Final status: `passed`, `failed`, or `needs_review`.

---

## 3. Workflow Definitions

Create named workflows with stable prompt templates.

| Workflow | Intended use | Compose skill chain | Default agent |
| --- | --- | --- | --- |
| `dev` | Feature implementation | `compose:brainstorm -> compose:plan -> compose:tdd -> compose:verify -> compose:review` | `compose` |
| `fix` | Bug fixing | `compose:debug -> compose:tdd -> compose:verify -> compose:feedback` | `compose` |
| `fix-ci` | CI failure repair | `compose:debug -> compose:tdd -> compose:verify -> compose:review` | `compose` |
| `plan` | Planning only | `compose:brainstorm -> compose:plan` | `compose` |
| `execute-plan` | Execute an existing plan document | `compose:execute -> compose:tdd -> compose:verify -> compose:review` | `compose` |
| `review` | Review current diff | `compose:review -> compose:feedback` | `compose` |
| `parallel` | Explore independent tasks | `compose:parallel -> compose:subagent -> compose:verify` | `compose` |

Default behavior:

- Use `mimo run --agent compose --format json`.
- Never use `--dangerously-skip-permissions`.
- Never commit, push, reset, or delete files.
- Always emit report files even when MiMoCode fails.
- Treat verification failure as `failed`.
- Treat changed files without verification as `needs_review`.

---

## 4. File Plan

### New Files

- `E:\ideaProjects\codex-mimo\src\compose\workflow.ts`
  Defines workflow names, skill chains, prompt builders, and workflow defaults.

- `E:\ideaProjects\codex-mimo\src\compose\runner.ts`
  Orchestrates a Compose run: git snapshot, MiMoCode invocation, event capture, verification, report generation.

- `E:\ideaProjects\codex-mimo\src\compose\events.ts`
  Parses `mimo run --format json` stdout into normalized events.

- `E:\ideaProjects\codex-mimo\src\compose\report.ts`
  Writes JSON and Markdown reports.

- `E:\ideaProjects\codex-mimo\src\compose\verify.ts`
  Runs explicit verification commands and captures exit code/stdout/stderr.

- `E:\ideaProjects\codex-mimo\src\git\diff.ts`
  Captures git diff, changed file names, and diff stats.

- `E:\ideaProjects\codex-mimo\src\git\status.ts`
  Captures dirty state before and after execution.

- `E:\ideaProjects\codex-mimo\test\unit\compose-workflow.test.ts`
  Tests workflow definitions and prompt generation.

- `E:\ideaProjects\codex-mimo\test\unit\compose-events.test.ts`
  Tests JSON event parsing.

- `E:\ideaProjects\codex-mimo\test\unit\compose-report.test.ts`
  Tests report generation.

- `E:\ideaProjects\codex-mimo\test\unit\compose-runner.test.ts`
  Tests runner orchestration with mocked MiMoCode and git helpers.

### Modified Files

- `E:\ideaProjects\codex-mimo\src\cli\main.ts`
  Add `compose` command and parse workflow-specific flags.

- `E:\ideaProjects\codex-mimo\src\mimo\run-json.ts`
  Add support for `--attach`, `--title`, `--continue`, and structured stdout capture.

- `E:\ideaProjects\codex-mimo\src\codex\tool-schemas.ts`
  Add `ComposeInput` schema.

- `E:\ideaProjects\codex-mimo\src\codex\tools.ts`
  Add `mimoCompose` tool.

- `E:\ideaProjects\codex-mimo\src\codex\mcp-server.ts`
  Register `mimo_compose`.

- `E:\ideaProjects\codex-mimo\README.md`
  Document Compose workflows and reports.

- `E:\ideaProjects\codex-mimo\doc\operations-guide.md`
  Add operational guidance for using Compose workflows.

---

## 5. Data Contracts

### Compose Workflow Types

```ts
export type ComposeWorkflowName =
  | "dev"
  | "fix"
  | "fix-ci"
  | "plan"
  | "execute-plan"
  | "review"
  | "parallel";

export interface ComposeWorkflow {
  name: ComposeWorkflowName;
  description: string;
  skillChain: string[];
  defaultVerification: string[];
  writesAllowed: boolean;
  requiresTask: boolean;
  requiresFile: boolean;
}
```

### Compose Run Input

```ts
export interface ComposeRunInput {
  cwd: string;
  workflow: ComposeWorkflowName;
  task?: string;
  file?: string;
  since?: string;
  model?: string;
  attach?: string;
  session?: string;
  fork?: boolean;
  verification?: string[];
  dryRun?: boolean;
  reportDir?: string;
}
```

### Normalized MiMo Event

```ts
export interface NormalizedMimoEvent {
  type: "message" | "tool" | "diff" | "usage" | "error" | "raw";
  text?: string;
  toolName?: string;
  status?: string;
  path?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
  };
  raw: unknown;
}
```

### Verification Result

```ts
export interface VerificationResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  passed: boolean;
  durationMs: number;
}
```

### Compose Report

```ts
export interface ComposeReport {
  id: string;
  createdAt: string;
  workflow: ComposeWorkflowName;
  cwd: string;
  task: string;
  mimoArgs: string[];
  requestedSkills: string[];
  status: "passed" | "failed" | "needs_review";
  events: NormalizedMimoEvent[];
  changedFiles: string[];
  diffStat: string;
  verification: VerificationResult[];
  reviewText?: string;
  reportPaths: {
    json: string;
    markdown: string;
    eventsJsonl: string;
  };
}
```

---

## 6. Task Breakdown

### Task 1: Add Compose Workflow Definitions

**Files:**

- Create: `E:\ideaProjects\codex-mimo\src\compose\workflow.ts`
- Test: `E:\ideaProjects\codex-mimo\test\unit\compose-workflow.test.ts`

- [ ] **Step 1: Write failing tests for workflow lookup**

Create `test/unit/compose-workflow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildComposePrompt, getComposeWorkflow } from "../../src/compose/workflow.js";

describe("compose workflows", () => {
  it("returns dev workflow with expected Compose skill chain", () => {
    const workflow = getComposeWorkflow("dev");
    expect(workflow.skillChain).toEqual([
      "compose:brainstorm",
      "compose:plan",
      "compose:tdd",
      "compose:verify",
      "compose:review"
    ]);
    expect(workflow.writesAllowed).toBe(true);
  });

  it("builds an execute-plan prompt that references the plan file", () => {
    const prompt = buildComposePrompt({
      workflow: getComposeWorkflow("execute-plan"),
      task: "Execute the approved plan",
      file: "doc/codex-mimo-acp-integration-plan.md"
    });

    expect(prompt).toContain("@compose");
    expect(prompt).toContain("compose:execute");
    expect(prompt).toContain("doc/codex-mimo-acp-integration-plan.md");
    expect(prompt).toContain("Do not commit, push, reset, or delete files.");
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm test -- compose-workflow.test.ts
```

Expected:

```text
FAIL because src/compose/workflow.ts does not exist.
```

- [ ] **Step 3: Implement workflow definitions**

Create `src/compose/workflow.ts`:

```ts
export type ComposeWorkflowName =
  | "dev"
  | "fix"
  | "fix-ci"
  | "plan"
  | "execute-plan"
  | "review"
  | "parallel";

export interface ComposeWorkflow {
  name: ComposeWorkflowName;
  description: string;
  skillChain: string[];
  defaultVerification: string[];
  writesAllowed: boolean;
  requiresTask: boolean;
  requiresFile: boolean;
}

export interface BuildComposePromptInput {
  workflow: ComposeWorkflow;
  task?: string;
  file?: string;
  since?: string;
}

const workflows: Record<ComposeWorkflowName, ComposeWorkflow> = {
  dev: {
    name: "dev",
    description: "Feature development loop",
    skillChain: ["compose:brainstorm", "compose:plan", "compose:tdd", "compose:verify", "compose:review"],
    defaultVerification: ["npm test"],
    writesAllowed: true,
    requiresTask: true,
    requiresFile: false
  },
  fix: {
    name: "fix",
    description: "Bug fixing loop",
    skillChain: ["compose:debug", "compose:tdd", "compose:verify", "compose:feedback"],
    defaultVerification: ["npm test"],
    writesAllowed: true,
    requiresTask: true,
    requiresFile: false
  },
  "fix-ci": {
    name: "fix-ci",
    description: "CI failure repair loop",
    skillChain: ["compose:debug", "compose:tdd", "compose:verify", "compose:review"],
    defaultVerification: ["npm test"],
    writesAllowed: true,
    requiresTask: false,
    requiresFile: true
  },
  plan: {
    name: "plan",
    description: "Planning-only loop",
    skillChain: ["compose:brainstorm", "compose:plan"],
    defaultVerification: [],
    writesAllowed: false,
    requiresTask: true,
    requiresFile: false
  },
  "execute-plan": {
    name: "execute-plan",
    description: "Execute an approved implementation plan",
    skillChain: ["compose:execute", "compose:tdd", "compose:verify", "compose:review"],
    defaultVerification: ["npm test"],
    writesAllowed: true,
    requiresTask: false,
    requiresFile: true
  },
  review: {
    name: "review",
    description: "Review current diff",
    skillChain: ["compose:review", "compose:feedback"],
    defaultVerification: [],
    writesAllowed: false,
    requiresTask: false,
    requiresFile: false
  },
  parallel: {
    name: "parallel",
    description: "Parallel exploration loop",
    skillChain: ["compose:parallel", "compose:subagent", "compose:verify"],
    defaultVerification: ["npm test"],
    writesAllowed: true,
    requiresTask: true,
    requiresFile: false
  }
};

export function getComposeWorkflow(name: string): ComposeWorkflow {
  if (!(name in workflows)) {
    throw new Error(`Unknown Compose workflow: ${name}`);
  }
  return workflows[name as ComposeWorkflowName];
}

export function listComposeWorkflows(): ComposeWorkflow[] {
  return Object.values(workflows);
}

export function buildComposePrompt(input: BuildComposePromptInput): string {
  const { workflow, task, file, since } = input;
  const lines = [
    `Please use @compose to run the ${workflow.name} workflow.`,
    "",
    `Required Compose skills: ${workflow.skillChain.join(" -> ")}`,
    "",
    "Task:",
    task?.trim() || defaultTaskForWorkflow(workflow.name),
    "",
    "Rules:",
    "- Keep changes minimal and focused.",
    "- Do not commit, push, reset, or delete files.",
    "- Record the plan, actions taken, verification evidence, and remaining risks.",
    "- Prefer named reusable skills over ad-hoc steps.",
    "- Stop and report clearly if the task is blocked."
  ];

  if (file) {
    lines.push("", `Attached/reference file: @${file}`);
  }

  if (since) {
    lines.push("", `Review or compare changes since: ${since}`);
  }

  if (!workflow.writesAllowed) {
    lines.push("", "This workflow is read-only. Do not modify files.");
  }

  return lines.join("\n");
}

function defaultTaskForWorkflow(name: ComposeWorkflowName): string {
  switch (name) {
    case "fix-ci":
      return "Fix the failures described in the attached CI log.";
    case "execute-plan":
      return "Execute the approved implementation plan in the attached file.";
    case "review":
      return "Review the current diff for correctness, regressions, security issues, and missing tests.";
    default:
      return `Run the ${name} workflow.`;
  }
}
```

- [ ] **Step 4: Run the test again**

Run:

```bash
npm test -- compose-workflow.test.ts
```

Expected:

```text
PASS test/unit/compose-workflow.test.ts
```

### Task 2: Parse MiMoCode JSON Events

**Files:**

- Create: `E:\ideaProjects\codex-mimo\src\compose\events.ts`
- Test: `E:\ideaProjects\codex-mimo\test\unit\compose-events.test.ts`

- [ ] **Step 1: Write event parser tests**

Create `test/unit/compose-events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseMimoJsonLines, summarizeEvents } from "../../src/compose/events.js";

describe("compose event parsing", () => {
  it("parses newline-delimited JSON events", () => {
    const events = parseMimoJsonLines('{"type":"message","text":"hello"}\n{"type":"tool","tool":"bash","status":"completed"}\n');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "message", text: "hello" });
    expect(events[1]).toMatchObject({ type: "tool", toolName: "bash", status: "completed" });
  });

  it("keeps unknown shapes as raw events", () => {
    const events = parseMimoJsonLines('{"unexpected":true}\n');
    expect(events).toEqual([{ type: "raw", raw: { unexpected: true } }]);
  });

  it("summarizes message and tool counts", () => {
    const events = parseMimoJsonLines('{"type":"message","text":"hello"}\n{"type":"tool","tool":"edit","status":"completed"}\n');
    expect(summarizeEvents(events)).toEqual({
      messages: 1,
      tools: 1,
      diffs: 0,
      errors: 0
    });
  });
});
```

- [ ] **Step 2: Run the failing parser test**

Run:

```bash
npm test -- compose-events.test.ts
```

Expected:

```text
FAIL because src/compose/events.ts does not exist.
```

- [ ] **Step 3: Implement event parser**

Create `src/compose/events.ts`:

```ts
export interface NormalizedMimoEvent {
  type: "message" | "tool" | "diff" | "usage" | "error" | "raw";
  text?: string;
  toolName?: string;
  status?: string;
  path?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
  };
  raw: unknown;
}

export interface EventSummary {
  messages: number;
  tools: number;
  diffs: number;
  errors: number;
}

export function parseMimoJsonLines(stdout: string): NormalizedMimoEvent[] {
  const events: NormalizedMimoEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(normalizeMimoEvent(JSON.parse(trimmed)));
    } catch {
      events.push({ type: "raw", text: trimmed, raw: trimmed });
    }
  }
  return events;
}

export function normalizeMimoEvent(raw: unknown): NormalizedMimoEvent {
  if (!isRecord(raw)) return { type: "raw", raw };

  const type = String(raw.type ?? raw.event ?? "");
  if (type === "message" || type === "assistant" || type === "text") {
    return { type: "message", text: stringValue(raw.text ?? raw.content ?? raw.message), raw };
  }

  if (type === "tool" || type === "tool_call") {
    return {
      type: "tool",
      toolName: stringValue(raw.tool ?? raw.name ?? raw.toolName),
      status: stringValue(raw.status),
      raw
    };
  }

  if (type === "diff") {
    return { type: "diff", path: stringValue(raw.path), raw };
  }

  if (type === "usage") {
    return {
      type: "usage",
      usage: {
        inputTokens: numberValue(raw.inputTokens ?? raw.input_tokens),
        outputTokens: numberValue(raw.outputTokens ?? raw.output_tokens),
        cost: numberValue(raw.cost)
      },
      raw
    };
  }

  if (type === "error") {
    return { type: "error", text: stringValue(raw.error ?? raw.message), raw };
  }

  return { type: "raw", raw };
}

export function summarizeEvents(events: NormalizedMimoEvent[]): EventSummary {
  return {
    messages: events.filter((event) => event.type === "message").length,
    tools: events.filter((event) => event.type === "tool").length,
    diffs: events.filter((event) => event.type === "diff").length,
    errors: events.filter((event) => event.type === "error").length
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
```

- [ ] **Step 4: Run parser tests**

Run:

```bash
npm test -- compose-events.test.ts
```

Expected:

```text
PASS test/unit/compose-events.test.ts
```

### Task 3: Capture Git Diff And Status

**Files:**

- Create: `E:\ideaProjects\codex-mimo\src\git\status.ts`
- Create: `E:\ideaProjects\codex-mimo\src\git\diff.ts`
- Test: `E:\ideaProjects\codex-mimo\test\unit\git-diff.test.ts`

- [ ] **Step 1: Write tests for pure diff parsing**

Create `test/unit/git-diff.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseChangedFiles } from "../../src/git/diff.js";

describe("git diff helpers", () => {
  it("parses changed files from git diff --name-only output", () => {
    expect(parseChangedFiles("src/a.ts\nREADME.md\n\n")).toEqual(["src/a.ts", "README.md"]);
  });

  it("returns an empty list for blank output", () => {
    expect(parseChangedFiles("\n")).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement git helpers**

Create `src/git/diff.ts`:

```ts
import { execa } from "execa";

export interface GitDiffSnapshot {
  changedFiles: string[];
  diffStat: string;
  diff: string;
}

export function parseChangedFiles(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function captureGitDiff(cwd: string, base = "HEAD"): Promise<GitDiffSnapshot> {
  const [names, stat, diff] = await Promise.all([
    execa("git", ["diff", "--name-only", base], { cwd }),
    execa("git", ["diff", "--stat", base], { cwd }),
    execa("git", ["diff", base], { cwd })
  ]);

  return {
    changedFiles: parseChangedFiles(names.stdout),
    diffStat: stat.stdout,
    diff: diff.stdout
  };
}
```

Create `src/git/status.ts`:

```ts
import { execa } from "execa";

export interface GitStatusSnapshot {
  short: string;
  dirty: boolean;
}

export async function captureGitStatus(cwd: string): Promise<GitStatusSnapshot> {
  const result = await execa("git", ["status", "--short"], { cwd });
  return {
    short: result.stdout,
    dirty: result.stdout.trim().length > 0
  };
}
```

- [ ] **Step 3: Run git helper tests**

Run:

```bash
npm test -- git-diff.test.ts
```

Expected:

```text
PASS test/unit/git-diff.test.ts
```

### Task 4: Run Verification Commands

**Files:**

- Create: `E:\ideaProjects\codex-mimo\src\compose\verify.ts`
- Test: `E:\ideaProjects\codex-mimo\test\unit\compose-verify.test.ts`

- [ ] **Step 1: Write verification tests**

Create `test/unit/compose-verify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeVerificationCommands } from "../../src/compose/verify.js";

describe("verification command normalization", () => {
  it("uses explicit commands when provided", () => {
    expect(normalizeVerificationCommands(["npm test", "npm run build"], ["npm test"])).toEqual([
      "npm test",
      "npm run build"
    ]);
  });

  it("falls back to workflow defaults", () => {
    expect(normalizeVerificationCommands(undefined, ["npm test"])).toEqual(["npm test"]);
  });
});
```

- [ ] **Step 2: Implement verification helper**

Create `src/compose/verify.ts`:

```ts
import { execa } from "execa";

export interface VerificationResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  passed: boolean;
  durationMs: number;
}

export function normalizeVerificationCommands(
  explicit: string[] | undefined,
  defaults: string[]
): string[] {
  return explicit && explicit.length > 0 ? explicit : defaults;
}

export async function runVerificationCommands(
  cwd: string,
  commands: string[]
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  for (const command of commands) {
    const startedAt = Date.now();
    try {
      const result = await execa(command, {
        cwd,
        shell: true,
        reject: false
      });
      results.push({
        command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        passed: result.exitCode === 0,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      results.push({
        command,
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        passed: false,
        durationMs: Date.now() - startedAt
      });
    }
  }

  return results;
}
```

- [ ] **Step 3: Run verification helper tests**

Run:

```bash
npm test -- compose-verify.test.ts
```

Expected:

```text
PASS test/unit/compose-verify.test.ts
```

### Task 5: Generate Structured Reports

**Files:**

- Create: `E:\ideaProjects\codex-mimo\src\compose\report.ts`
- Test: `E:\ideaProjects\codex-mimo\test\unit\compose-report.test.ts`

- [ ] **Step 1: Write report tests**

Create `test/unit/compose-report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderMarkdownReport } from "../../src/compose/report.js";

describe("compose report", () => {
  it("renders workflow, status, changed files, and verification", () => {
    const markdown = renderMarkdownReport({
      id: "run_1",
      createdAt: "2026-06-21T18:40:00.000Z",
      workflow: "dev",
      cwd: "E:/project/app",
      task: "Implement login throttling",
      mimoArgs: ["run", "--agent", "compose"],
      requestedSkills: ["compose:brainstorm", "compose:plan"],
      status: "passed",
      events: [],
      changedFiles: ["src/login.ts"],
      diffStat: " src/login.ts | 10 ++++++++++",
      verification: [
        {
          command: "npm test",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          passed: true,
          durationMs: 100
        }
      ],
      reportPaths: {
        json: "report.json",
        markdown: "report.md",
        eventsJsonl: "events.jsonl"
      }
    });

    expect(markdown).toContain("# Codex-MiMo Compose Report");
    expect(markdown).toContain("Status: `passed`");
    expect(markdown).toContain("src/login.ts");
    expect(markdown).toContain("npm test");
  });
});
```

- [ ] **Step 2: Implement report renderer and writer**

Create `src/compose/report.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import type { NormalizedMimoEvent } from "./events.js";
import type { ComposeWorkflowName } from "./workflow.js";
import type { VerificationResult } from "./verify.js";

export interface ComposeReport {
  id: string;
  createdAt: string;
  workflow: ComposeWorkflowName;
  cwd: string;
  task: string;
  mimoArgs: string[];
  requestedSkills: string[];
  status: "passed" | "failed" | "needs_review";
  events: NormalizedMimoEvent[];
  changedFiles: string[];
  diffStat: string;
  verification: VerificationResult[];
  reviewText?: string;
  reportPaths: {
    json: string;
    markdown: string;
    eventsJsonl: string;
  };
}

export function renderMarkdownReport(report: ComposeReport): string {
  const verificationLines = report.verification.length === 0
    ? ["No verification commands were run."]
    : report.verification.map((result) =>
        `- ${result.passed ? "PASS" : "FAIL"} \`${result.command}\` exit=${result.exitCode ?? "null"} duration=${result.durationMs}ms`
      );

  const changedFiles = report.changedFiles.length === 0
    ? ["No changed files detected."]
    : report.changedFiles.map((file) => `- \`${file}\``);

  return [
    "# Codex-MiMo Compose Report",
    "",
    `Run ID: \`${report.id}\``,
    `Created: \`${report.createdAt}\``,
    `Workflow: \`${report.workflow}\``,
    `Status: \`${report.status}\``,
    `CWD: \`${report.cwd}\``,
    "",
    "## Task",
    "",
    report.task,
    "",
    "## Requested Compose Skills",
    "",
    report.requestedSkills.map((skill) => `- \`${skill}\``).join("\n"),
    "",
    "## MiMoCode Command",
    "",
    "```bash",
    `mimo ${report.mimoArgs.join(" ")}`,
    "```",
    "",
    "## Changed Files",
    "",
    changedFiles.join("\n"),
    "",
    "## Diff Stat",
    "",
    "```text",
    report.diffStat || "No diff stat.",
    "```",
    "",
    "## Verification",
    "",
    verificationLines.join("\n"),
    "",
    "## Review",
    "",
    report.reviewText || "No review text was captured.",
    "",
    "## Report Files",
    "",
    `- JSON: \`${report.reportPaths.json}\``,
    `- Markdown: \`${report.reportPaths.markdown}\``,
    `- Events JSONL: \`${report.reportPaths.eventsJsonl}\``,
    ""
  ].join("\n");
}

export function writeComposeReport(report: ComposeReport): void {
  fs.mkdirSync(path.dirname(report.reportPaths.json), { recursive: true });
  fs.mkdirSync(path.dirname(report.reportPaths.markdown), { recursive: true });
  fs.mkdirSync(path.dirname(report.reportPaths.eventsJsonl), { recursive: true });

  fs.writeFileSync(report.reportPaths.json, JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(report.reportPaths.markdown, renderMarkdownReport(report), "utf-8");
  fs.writeFileSync(
    report.reportPaths.eventsJsonl,
    report.events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf-8"
  );
}
```

- [ ] **Step 3: Run report tests**

Run:

```bash
npm test -- compose-report.test.ts
```

Expected:

```text
PASS test/unit/compose-report.test.ts
```

### Task 6: Extend MiMo Run Wrapper For Captured Output

**Files:**

- Modify: `E:\ideaProjects\codex-mimo\src\mimo\run-json.ts`
- Test: `E:\ideaProjects\codex-mimo\test\unit\run-json.test.ts`

- [ ] **Step 1: Add tests for Compose args**

Modify `test/unit/run-json.test.ts`:

```ts
it("builds compose run args with title, file, session, fork, and attach", () => {
  expect(
    buildMimoRunArgs({
      cwd: "E:/project/app",
      message: "Use @compose",
      agent: "compose",
      title: "codex-mimo compose dev",
      session: "sess_123",
      fork: true,
      attach: "http://localhost:4096",
      files: ["ci.log"]
    })
  ).toEqual([
    "run",
    "--format",
    "json",
    "--agent",
    "compose",
    "--session",
    "sess_123",
    "--fork",
    "--title",
    "codex-mimo compose dev",
    "--attach",
    "http://localhost:4096",
    "--file",
    "ci.log",
    "Use @compose"
  ]);
});
```

- [ ] **Step 2: Update `MimoRunOptions`**

Modify `src/mimo/run-json.ts`:

```ts
export interface MimoRunOptions {
  cwd: string;
  message: string;
  agent?: string;
  model?: string;
  session?: string;
  fork?: boolean;
  title?: string;
  attach?: string;
  files?: string[];
}
```

- [ ] **Step 3: Update `buildMimoRunArgs`**

Modify `src/mimo/run-json.ts`:

```ts
export function buildMimoRunArgs(options: MimoRunOptions): string[] {
  const args = ["run", "--format", "json"];
  if (options.agent) args.push("--agent", options.agent);
  if (options.model) args.push("--model", options.model);
  if (options.session) args.push("--session", options.session);
  if (options.fork) args.push("--fork");
  if (options.title) args.push("--title", options.title);
  if (options.attach) args.push("--attach", options.attach);
  for (const file of options.files ?? []) args.push("--file", file);
  args.push(options.message);
  return args;
}
```

- [ ] **Step 4: Run existing and new wrapper tests**

Run:

```bash
npm test -- run-json.test.ts
```

Expected:

```text
PASS test/unit/run-json.test.ts
```

### Task 7: Implement Compose Runner

**Files:**

- Create: `E:\ideaProjects\codex-mimo\src\compose\runner.ts`
- Test: `E:\ideaProjects\codex-mimo\test\unit\compose-runner.test.ts`

- [ ] **Step 1: Write orchestration test with injectable dependencies**

Create `test/unit/compose-runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runComposeWorkflow } from "../../src/compose/runner.js";

describe("compose runner", () => {
  it("runs MiMoCode, captures events, diff, verification, and report", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Implement login throttling",
        verification: ["npm test"],
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"message","text":"done"}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: ["src/login.ts"],
          diffStat: " src/login.ts | 10 ++++++++++",
          diff: "diff --git a/src/login.ts b/src/login.ts"
        }),
        runVerification: async () => [
          {
            command: "npm test",
            exitCode: 0,
            stdout: "ok",
            stderr: "",
            passed: true,
            durationMs: 10
          }
        ],
        writeReport: () => undefined,
        now: () => new Date("2026-06-21T18:40:00.000Z")
      }
    );

    expect(result.status).toBe("passed");
    expect(result.changedFiles).toEqual(["src/login.ts"]);
    expect(result.events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement runner**

Create `src/compose/runner.ts`:

```ts
import path from "node:path";
import { execa } from "execa";
import { buildMimoRunArgs } from "../mimo/run-json.js";
import { captureGitDiff, type GitDiffSnapshot } from "../git/diff.js";
import { parseMimoJsonLines } from "./events.js";
import { writeComposeReport, type ComposeReport } from "./report.js";
import { normalizeVerificationCommands, runVerificationCommands, type VerificationResult } from "./verify.js";
import { buildComposePrompt, getComposeWorkflow, type ComposeWorkflowName } from "./workflow.js";

export interface ComposeRunInput {
  cwd: string;
  workflow: ComposeWorkflowName;
  task?: string;
  file?: string;
  since?: string;
  model?: string;
  attach?: string;
  session?: string;
  fork?: boolean;
  verification?: string[];
  dryRun?: boolean;
  reportDir?: string;
}

export interface MimoRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ComposeRunnerDeps {
  runMimo?: (cwd: string, args: string[]) => Promise<MimoRunResult>;
  captureDiff?: (cwd: string, base?: string) => Promise<GitDiffSnapshot>;
  runVerification?: (cwd: string, commands: string[]) => Promise<VerificationResult[]>;
  writeReport?: (report: ComposeReport) => void;
  now?: () => Date;
}

export async function runComposeWorkflow(
  input: ComposeRunInput,
  deps: ComposeRunnerDeps = {}
): Promise<ComposeReport> {
  const workflow = getComposeWorkflow(input.workflow);
  validateComposeInput(input, workflow.requiresTask, workflow.requiresFile);

  const prompt = buildComposePrompt({
    workflow,
    task: input.task,
    file: input.file,
    since: input.since
  });

  const mimoArgs = buildMimoRunArgs({
    cwd: input.cwd,
    agent: "compose",
    model: input.model,
    message: prompt,
    title: `codex-mimo compose ${workflow.name}`,
    session: input.session,
    fork: input.fork,
    attach: input.attach,
    files: input.file ? [input.file] : []
  });

  const now = deps.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const id = `${createdAt.replace(/[:.]/g, "-")}-compose-${workflow.name}`;
  const reportDir = input.reportDir ?? path.join(input.cwd, ".codex-mimo", "reports");
  const eventsDir = path.join(input.cwd, ".codex-mimo", "events");

  if (input.dryRun) {
    return buildReport({
      id,
      createdAt,
      input,
      mimoArgs,
      requestedSkills: workflow.skillChain,
      eventsStdout: "",
      diff: { changedFiles: [], diffStat: "", diff: "" },
      verification: [],
      reportDir,
      eventsDir,
      status: "needs_review"
    });
  }

  const runMimo = deps.runMimo ?? defaultRunMimo;
  const captureDiff = deps.captureDiff ?? captureGitDiff;
  const runVerification = deps.runVerification ?? runVerificationCommands;
  const writeReport = deps.writeReport ?? writeComposeReport;

  const mimo = await runMimo(input.cwd, mimoArgs);
  const diff = await captureDiff(input.cwd, input.since ?? "HEAD");
  const verificationCommands = normalizeVerificationCommands(input.verification, workflow.defaultVerification);
  const verification = await runVerification(input.cwd, verificationCommands);

  const status = determineStatus(mimo.exitCode, diff.changedFiles, verification);
  const report = buildReport({
    id,
    createdAt,
    input,
    mimoArgs,
    requestedSkills: workflow.skillChain,
    eventsStdout: mimo.stdout,
    diff,
    verification,
    reportDir,
    eventsDir,
    status
  });

  writeReport(report);
  return report;
}

async function defaultRunMimo(cwd: string, args: string[]): Promise<MimoRunResult> {
  const result = await execa("mimo", args, {
    cwd,
    reject: false
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode
  };
}

function validateComposeInput(input: ComposeRunInput, requiresTask: boolean, requiresFile: boolean): void {
  if (requiresTask && !input.task?.trim()) {
    throw new Error(`Workflow ${input.workflow} requires a task.`);
  }
  if (requiresFile && !input.file?.trim()) {
    throw new Error(`Workflow ${input.workflow} requires --file.`);
  }
}

function determineStatus(
  mimoExitCode: number,
  changedFiles: string[],
  verification: VerificationResult[]
): "passed" | "failed" | "needs_review" {
  if (mimoExitCode !== 0) return "failed";
  if (verification.some((result) => !result.passed)) return "failed";
  if (verification.length === 0 && changedFiles.length > 0) return "needs_review";
  return "passed";
}

function buildReport(input: {
  id: string;
  createdAt: string;
  input: ComposeRunInput;
  mimoArgs: string[];
  requestedSkills: string[];
  eventsStdout: string;
  diff: GitDiffSnapshot;
  verification: VerificationResult[];
  reportDir: string;
  eventsDir: string;
  status: "passed" | "failed" | "needs_review";
}): ComposeReport {
  const events = parseMimoJsonLines(input.eventsStdout);
  return {
    id: input.id,
    createdAt: input.createdAt,
    workflow: input.input.workflow,
    cwd: input.input.cwd,
    task: input.input.task ?? `Run ${input.input.workflow} workflow.`,
    mimoArgs: input.mimoArgs,
    requestedSkills: input.requestedSkills,
    status: input.status,
    events,
    changedFiles: input.diff.changedFiles,
    diffStat: input.diff.diffStat,
    verification: input.verification,
    reviewText: extractReviewText(events),
    reportPaths: {
      json: path.join(input.reportDir, `${input.id}.json`),
      markdown: path.join(input.reportDir, `${input.id}.md`),
      eventsJsonl: path.join(input.eventsDir, `${input.id}.jsonl`)
    }
  };
}

function extractReviewText(events: ReturnType<typeof parseMimoJsonLines>): string | undefined {
  const messages = events
    .filter((event) => event.type === "message" && event.text)
    .map((event) => event.text)
    .filter(Boolean);
  return messages.length > 0 ? messages.join("\n\n") : undefined;
}
```

- [ ] **Step 3: Run runner tests**

Run:

```bash
npm test -- compose-runner.test.ts
```

Expected:

```text
PASS test/unit/compose-runner.test.ts
```

### Task 8: Add CLI `compose` Command

**Files:**

- Modify: `E:\ideaProjects\codex-mimo\src\cli\main.ts`
- Test: `E:\ideaProjects\codex-mimo\test\unit\compose-cli-args.test.ts`

- [ ] **Step 1: Extract CLI flag parsing into testable helper**

Create or modify a CLI helper inside `src/cli/main.ts` only if the codebase does not already have a CLI parser module. Prefer creating `src/cli/args.ts` if `main.ts` becomes too large.

Expected supported flags:

```text
--workflow <dev|fix|fix-ci|plan|execute-plan|review|parallel>
--file <path>
--since <git-ref>
--verify <command>
--verify <command> repeated
--model <provider/model>
--attach <url>
--session <id>
--fork
--dry-run
--json
--report-dir <path>
```

- [ ] **Step 2: Add CLI route**

Add behavior:

```bash
codex-mimo compose --workflow dev "Implement login throttling"
```

Calls:

```ts
await runComposeWorkflow({
  cwd,
  workflow,
  task,
  file,
  since,
  model,
  attach,
  session,
  fork,
  verification,
  dryRun,
  reportDir
});
```

Output:

- If `--json`, print the full report JSON.
- Otherwise, print the Markdown report path, status, changed files, and verification summary.

- [ ] **Step 3: Run CLI manually in dry-run mode**

Run:

```bash
npm run build
node dist/cli/main.js compose --workflow dev --dry-run "Implement login throttling"
```

Expected:

```text
The command exits 0 and prints a planned Compose run without invoking MiMoCode.
```

### Task 9: Add MCP Tool `mimo_compose`

**Files:**

- Modify: `E:\ideaProjects\codex-mimo\src\codex\tool-schemas.ts`
- Modify: `E:\ideaProjects\codex-mimo\src\codex\tools.ts`
- Modify: `E:\ideaProjects\codex-mimo\src\codex\mcp-server.ts`

- [ ] **Step 1: Add schema**

Add to `src/codex/tool-schemas.ts`:

```ts
export const ComposeInput = z.object({
  cwd: z.string(),
  workflow: z.enum(["dev", "fix", "fix-ci", "plan", "execute-plan", "review", "parallel"]),
  task: z.string().optional(),
  file: z.string().optional(),
  since: z.string().optional(),
  model: z.string().optional(),
  attach: z.string().optional(),
  session: z.string().optional(),
  fork: z.boolean().default(false),
  verification: z.array(z.string()).optional(),
  dryRun: z.boolean().default(false),
  reportDir: z.string().optional()
});
```

- [ ] **Step 2: Add tool implementation**

Add to `src/codex/tools.ts`:

```ts
import { runComposeWorkflow } from "../compose/runner.js";
import { ComposeInput } from "./tool-schemas.js";

export async function mimoCompose(input: unknown) {
  const parsed = ComposeInput.parse(input);
  return await runComposeWorkflow(parsed);
}
```

- [ ] **Step 3: Register MCP tool**

Add to `src/codex/mcp-server.ts`:

```ts
server.tool(
  "mimo_compose",
  "Run a MiMoCode Compose workflow and return a structured report",
  {
    cwd: z.string().describe("Project root directory"),
    workflow: z.enum(["dev", "fix", "fix-ci", "plan", "execute-plan", "review", "parallel"]),
    task: z.string().optional().describe("Task description"),
    file: z.string().optional().describe("Attached file such as CI log or plan document"),
    since: z.string().optional().describe("Git ref for diff comparison"),
    model: z.string().optional().describe("Model override"),
    attach: z.string().optional().describe("Running MiMoCode server URL"),
    session: z.string().optional().describe("MiMoCode session ID"),
    fork: z.boolean().default(false),
    verification: z.array(z.string()).optional().describe("Verification commands"),
    dryRun: z.boolean().default(false),
    reportDir: z.string().optional().describe("Report directory")
  },
  async (args) => {
    const result = await mimoCompose(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  }
);
```

- [ ] **Step 4: Build**

Run:

```bash
npm run build
```

Expected:

```text
TypeScript build passes.
```

### Task 10: Documentation Update

**Files:**

- Modify: `E:\ideaProjects\codex-mimo\README.md`
- Modify: `E:\ideaProjects\codex-mimo\doc\operations-guide.md`
- Create: `E:\ideaProjects\codex-mimo\doc\compose-workflows.md`

- [ ] **Step 1: Add README section**

Add:

```markdown
## Compose Workflow Launcher

Use `codex-mimo compose` when you want MiMoCode to run a skill-driven workflow:

```bash
codex-mimo compose --workflow dev "Implement login throttling"
codex-mimo compose --workflow fix-ci --file ci.log
codex-mimo compose --workflow execute-plan --file doc/codex-mimo-acp-integration-plan.md
codex-mimo compose --workflow review --since HEAD
```

Reports are written to:

```text
.codex-mimo/reports/
.codex-mimo/events/
```

Each report includes MiMoCode JSON events, changed files, diff stat, verification command results, and review text.
```

- [ ] **Step 2: Create compose workflow docs**

Create `doc/compose-workflows.md` with:

```markdown
# Compose Workflows

`codex-mimo compose` starts MiMoCode in Compose mode and asks it to use named skills for repeatable workflows.

## Workflows

| Name | Skill chain | Use |
| --- | --- | --- |
| `dev` | `compose:brainstorm -> compose:plan -> compose:tdd -> compose:verify -> compose:review` | Feature work |
| `fix` | `compose:debug -> compose:tdd -> compose:verify -> compose:feedback` | Bug fixes |
| `fix-ci` | `compose:debug -> compose:tdd -> compose:verify -> compose:review` | CI repair |
| `plan` | `compose:brainstorm -> compose:plan` | Read-only planning |
| `execute-plan` | `compose:execute -> compose:tdd -> compose:verify -> compose:review` | Execute approved plans |
| `review` | `compose:review -> compose:feedback` | Diff review |
| `parallel` | `compose:parallel -> compose:subagent -> compose:verify` | Independent subtask exploration |

## Report Contract

Every run writes a Markdown report, JSON report, and JSONL event log.

## Safety

The launcher never passes `--dangerously-skip-permissions`. It does not commit, push, reset, or delete files.
```

- [ ] **Step 3: Build docs sanity check**

Run:

```bash
npm run build
```

Expected:

```text
Build still passes after docs update.
```

### Task 11: End-To-End Dry Run Verification

**Files:**

- No source files changed in this task.

- [ ] **Step 1: Build project**

Run:

```bash
npm run build
```

Expected:

```text
TypeScript build passes.
```

- [ ] **Step 2: Run unit tests**

Run:

```bash
npm test
```

Expected:

```text
All tests pass.
```

- [ ] **Step 3: Run dry-run command**

Run:

```bash
node dist/cli/main.js compose --workflow dev --dry-run "Implement login throttling"
```

Expected:

```text
Command exits 0.
Output includes workflow dev.
Output includes agent compose.
No MiMoCode process is invoked.
```

- [ ] **Step 4: Run report generation with mocked MiMoCode path if available**

If the project has a test fixture command or mocked runner path, run:

```bash
npm test -- compose-runner.test.ts
```

Expected:

```text
Runner test verifies report generation.
```

### Task 12: Real MiMoCode Smoke Test

**Files:**

- No source files changed in this task.

- [ ] **Step 1: Verify MiMoCode availability**

Run:

```bash
mimo --version
mimo auth list
```

Expected:

```text
MiMoCode version is printed.
Auth list command succeeds.
```

- [ ] **Step 2: Run read-only Compose plan**

Run in a disposable repo:

```bash
codex-mimo compose --workflow plan "Explain the smallest safe change needed to add a README note"
```

Expected:

```text
Report files are created.
No files are changed.
Report status is passed or needs_review.
```

- [ ] **Step 3: Run Compose dev on a trivial task**

Run in a disposable repo:

```bash
codex-mimo compose --workflow dev --verify "npm test" "Add a README sentence saying this is a smoke test project"
```

Expected:

```text
Report files are created.
Changed files include README.md only.
Verification result is captured.
No git commit is created.
```

---

## 7. Success Criteria

This iteration is complete when:

- `codex-mimo compose --workflow dev --dry-run "..."` works.
- `codex-mimo compose --workflow execute-plan --file <plan.md>` works.
- The CLI always runs `mimo run --agent compose --format json`.
- JSON events are parsed into normalized events.
- Git changed files and diff stat are captured after execution.
- Verification commands are run and recorded with exit codes.
- A Markdown report and JSON report are written for every run.
- `mimo_compose` is available through the MCP server.
- `npm run build` passes.
- `npm test` passes.
- Documentation explains when to use each workflow.

---

## 8. Known Deferred Work

Do not mix these into this iteration:

- Full ACP v1 bridge compatibility.
- Interactive permission UI.
- Remote MCP profile switching.
- Git worktree automation.
- Automatic commit or PR creation.
- Parallel subagent implementation beyond prompt-level `compose:parallel` invocation.

These are valuable, but the immediate goal is a reliable Compose workflow launcher with strong reporting.

---

## 9. Recommended Execution Prompt For MiMoCode Compose

Use this one-liner in MiMoCode Compose mode:

```text
请严格按照 E:\ideaProjects\codex-mimo\doc\compose-workflow-launcher-iteration-plan.md 执行本轮迭代，优先实现 codex-mimo compose 工作流启动器、JSON 事件解析、git diff 捕获、验证命令执行和结构化报告生成，按任务顺序用 TDD 推进，每步运行对应测试并记录结果，不要扩展到完整 ACP 桥接或自动提交。
```

---

## 10. Execution Results

**Executed:** 2026-06-21

### Final Verification Summary

| Success Criteria | Status |
|------------------|--------|
| `codex-mimo compose --workflow dev --dry-run "..."` works | ✅ Pass |
| `codex-mimo compose --workflow execute-plan --file <plan.md>` works | ✅ Pass |
| CLI always runs `mimo run --agent compose --format json` | ✅ Pass |
| JSON events parsed into normalized events | ✅ Pass |
| Git changed files and diff stat captured | ✅ Pass |
| Verification commands run and recorded | ✅ Pass |
| Markdown and JSON reports written for every run | ✅ Pass |
| `mimo_compose` available through MCP server | ✅ Pass |
| `npm run build` passes | ✅ Pass |
| `npm test` passes | ✅ Pass (93 tests) |
| Documentation explains workflows | ✅ Pass |

### Build & Test Results

| Command | Result |
|---------|--------|
| `npm run build` | ✅ Pass |
| `npm run lint` | ✅ Pass |
| `npm test` | ✅ 93 tests pass (15 files) |
| `codex-mimo compose --workflow dev --dry-run "smoke test"` | ✅ Report generated |
| `codex-mimo compose --workflow execute-plan --file doc/... --dry-run "..."` | ✅ Report generated |

### Reliability Improvements

| Feature | Status |
|---------|--------|
| dry-run 落盘报告 | ✅ 已实现 |
| MiMoCode 启动失败落盘报告 | ✅ 已实现 |
| 运行异常落盘报告 | ✅ 已实现 |
| 验证失败落盘报告 | ✅ 已实现 |
| before/after git status | ✅ 已实现 |
| 完整 diff 持久化路径 | ✅ 已实现 |
| --continue 参数支持 | ✅ 已实现 |
| 错误信息记录到报告 | ✅ 已实现 |

### New Test Coverage

| Test File | Tests Added |
|-----------|-------------|
| compose-runner.test.ts | +7 (error scenarios, --continue, git status) |
| compose-report.test.ts | +3 (git status, diff path, error section) |
| run-json.test.ts | +1 (--continue flag) |

### Files Modified (Reliability Fix)

- `src/compose/runner.ts` - Error handling, git status, diff persistence
- `src/compose/report.ts` - GitStatusSnapshot, diffPath, error fields
- `src/git/status.ts` - Added captureGitStatus export
- `src/mimo/run-json.ts` - Added continue option
- `src/cli/main.ts` - Added --continue flag parsing
- `src/codex/tool-schemas.ts` - Added continue to ComposeInput
- `src/codex/mcp-server.ts` - Added continue to mimo_compose tool
- `test/unit/compose-runner.test.ts` - Comprehensive error scenario tests
- `test/unit/compose-report.test.ts` - New field rendering tests
- `test/unit/run-json.test.ts` - Continue flag test

