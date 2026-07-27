# Codex-MiMo Compact Results and Unified Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MCP results and heartbeat status compact by default, preserve complete details behind explicit output levels, and persist final plans/results/verification evidence as durable report artifacts.

**Architecture:** Add named compact/standard/full public result types, keep the existing detailed renderers as the standard operator view, and add explicit compact/full renderers. Finalizers write semantic output and full verification evidence before the atomic job transition; MCP and automatic callbacks consume the compact projection, while `level: "full"` reads the saved artifacts.

**Tech Stack:** TypeScript with NodeNext ESM, Zod, Node filesystem APIs, Vitest, existing unified job worker, existing Compose report writer, existing Codex App Server notification adapter.

## Global Constraints

- This plan implements Phase 1 only: output levels, compact heartbeat status, unified result/plan/verification artifacts, and compact prefetched callbacks.
- Do not implement `stalled`, effective-progress timers, expanded resume eligibility, ordered development acceptance, or slice-chain orchestration in this phase.
- `mimo_result` and `mimo_status` default to `compact`; CLI `status` explicitly defaults to `standard`.
- Compact result JSON must remain at or below 6,000 UTF-8 bytes.
- Compact report paths are repository-relative when the artifact is inside the workspace; standard/full retain exact persisted paths.
- A compact implementation result contains only status, changed files, compact tests, failure, report path, and conditional attention. Planning/review results may add a summary capped at 500 characters.
- Compact and standard results never inline full model output, verification stdout/stderr, job logs, raw events, or diffs.
- `full` is explicit operator diagnostics. Read complete semantic artifacts, safe job logs, verification evidence, and diffs; redact recognized credentials before returning them.
- Full diagnostic artifacts have a 1,000,000-byte per-artifact inline ceiling; larger files return `artifact_too_large` with the exact path and byte count instead of truncation.
- Automatic Codex callbacks always use the compact result projection and a new version marker. They never include `output`.
- Full plan text is written by the host to `.codex-mimo/reports/<jobId>.plan.md`; MiMoCode remains prohibited from writing a plan file during a read-only workflow.
- Structural `.json` and `.md` reports must not contain final model text, raw event payloads, verification stdout/stderr, task prompts, or private notification data.
- Preserve `session.post`, read-only Git checks, outcome classification, atomic transition/outbox behavior, and the existing 30-minute `idleTimeoutMs`.
- Use `.js` extensions in TypeScript imports and exported named return types for declaration generation.
- Add no dependency; use `Buffer.byteLength()` for the compact byte budget.
- Re-read and merge the user's existing uncommitted edits in `.codex-plugin/plugin.json`, `README.md`, `doc/operations-guide.md`, `skills/mimocode/SKILL.md`, and `test/unit/packaged-skill.test.ts`; do not replace those files wholesale.
- Do not modify historical 2026-07-20 through 2026-07-23 specs/plans. The 2026-07-26 design explicitly supersedes their output-rich result sections.
- Use `npm.cmd` commands on Windows.
- Do not create a Git commit unless the user explicitly authorizes commits. Commit steps below are conditional checkpoints only.

---

## File Structure

- `src/core/jobs.ts`: Own named output-level, compact/standard/full result, heartbeat, diagnostic verification, and report-path interfaces.
- `src/codex/tool-schemas.ts`: Validate `level: compact|standard|full` and default MCP control calls to compact.
- `src/core/job-store.ts`: Accept the new persisted artifact path keys.
- `src/core/job-output.ts`: Read final output and diagnostic artifacts, extract bounded semantic summaries, and redact recognized credentials.
- `src/core/job-artifacts.ts`: Create structural direct-job reports and semantic result/plan/verification artifacts without changing outcome classification.
- `src/core/job-definitions.ts`: Invoke artifact persistence after outcome/read-only classification and before returning `JobOutcome`.
- `src/compose/report.ts`: Carry new artifact paths through the existing Compose structural report.
- `src/core/job-render.ts`: Render compact, standard, and full results and compact/standard status.
- `src/codex/tools.ts`: Select renderers by requested level and avoid expensive diagnostic reads for compact status.
- `src/cli/commands.ts`: Accept `--level`; make human CLI status standard while result remains compact by default.
- `src/codex/mcp-server.ts`: Describe compact defaults and artifact-based plan delivery.
- `src/notify/codex-adapter.ts`: Prefetch only compact result data with `MIMO_CALLBACK_RESULT_V2`.
- `test/unit/core/job-artifacts.test.ts`: Prove artifact contents, structural redaction boundaries, and path generation.
- Existing unit/integration/contract tests: Freeze output-level behavior and replace output-rich default expectations.
- `skills/mimocode/SKILL.md`, `README.md`, `doc/operations-guide.md`, `doc/compose-workflows.md`: Publish the compact-default contract and explicit full diagnostics path.

### Task 1: Freeze output-level types, schemas, and persisted path keys

**Files:**
- Modify: `src/core/jobs.ts:36-176`
- Modify: `src/codex/tool-schemas.ts:85-107`
- Modify: `src/core/job-store.ts:619-626`
- Modify: `scripts/validate-plugin.mjs:25-109,456-461`
- Modify: `test/unit/tool-schemas.test.ts:119-132`
- Modify: `test/unit/job-store.test.ts:414-432`
- Modify: `test/unit/plugin-validator.test.ts:27-89,153-156,231-270`

**Interfaces:**
- Produces: `JobOutputLevel`, `CompactJobResult`, `StandardJobResult`, `FullJobResult`, `RenderedJobResult`, `CompactJobStatus`, `RenderedJobStatus`, and `JobVerificationDetails`.
- Extends: `JobReportPaths` with `result`, `plan`, and `verification`.
- Produces: `JobOutputLevelSchema`; `JobStatusInput` and `JobResultInput` parse a default level of `"compact"`.

- [ ] **Step 1: Write failing schema and store tests**

Add to `test/unit/tool-schemas.test.ts`:

```ts
it.each([JobStatusInput, JobResultInput])(
  "defaults output level to compact and accepts explicit levels %#",
  (schema) => {
    expect(schema.parse({ cwd: "E:/project" })).toMatchObject({
      cwd: "E:/project",
      level: "compact"
    });
    expect(schema.parse({ cwd: "E:/project", level: "standard" }).level).toBe("standard");
    expect(schema.parse({ cwd: "E:/project", level: "full" }).level).toBe("full");
    expect(() => schema.parse({ cwd: "E:/project", level: "verbose" })).toThrow();
  }
);
```

Add to `test/unit/job-store.test.ts`:

```ts
it("reads persisted semantic artifact paths", () => {
  const cwd = tempWorkspace();
  const job = createJobStore(cwd).create({
    kind: "plan",
    task: "plan",
    request: { cwd, task: "plan" }
  });
  const reportPaths = {
    json: path.join(cwd, ".codex-mimo", "reports", `${job.id}.json`),
    markdown: path.join(cwd, ".codex-mimo", "reports", `${job.id}.md`),
    result: path.join(cwd, ".codex-mimo", "reports", `${job.id}.result.md`),
    plan: path.join(cwd, ".codex-mimo", "reports", `${job.id}.plan.md`),
    verification: path.join(cwd, ".codex-mimo", "reports", `${job.id}.verification.json`)
  };

  updateJob(cwd, job.id, { reportPaths });

  expect(readJob(cwd, job.id)?.reportPaths).toEqual(reportPaths);
});
```

In `test/unit/plugin-validator.test.ts`, add canonical `mimo_status`/`mimo_result` fixture schemas
with the compact level default, then add:

```ts
it.each(["mimo_status", "mimo_result"] as const)(
  "rejects %s without the canonical compact output level",
  (name) => {
    const root = createPluginFixture(
      "---\nname: mimocode\ndescription: Use MiMoCode.\n---",
      {
        mutateTools: (tools) => {
          const schema = tools.find((tool) => tool.name === name)!.inputSchema;
          delete (schema.properties as Record<string, unknown>).level;
        }
      }
    );

    const result = runValidator(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${name} input schema must match the canonical contract`
    );
  }
);
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```powershell
npm.cmd test -- tool-schemas.test.ts job-store.test.ts
```

Expected: FAIL because the control schemas have no `level` default and persisted report validation does not recognize the new path fields.

- [ ] **Step 3: Add the named public types**

Extend `src/core/jobs.ts` with these declarations while retaining the existing `JobStatusResult`, `JobNotificationStatus`, and job-record fields:

```ts
export type JobOutputLevel = "compact" | "standard" | "full";

export type AcceptanceStage = "build" | "test" | "diff_check";
export type AcceptanceOutcome = "passed" | "failed" | "not_applicable";

export interface JobVerificationDetails extends JobVerification {
  stdout: string;
  stderr: string;
}

export interface JobReportPaths {
  json?: string;
  markdown?: string;
  eventsJsonl?: string;
  diff?: string;
  result?: string;
  plan?: string;
  verification?: string;
}

export interface CompactAcceptanceResult {
  stage: AcceptanceStage;
  command: string;
  outcome: AcceptanceOutcome;
}

export interface CompactFailure {
  code: string;
  reason: string;
  failedStage?: AcceptanceStage;
  failedCommand?: string;
  failedTests?: string[];
  suggestion?: string;
}

export interface CompactAttention {
  kind: "needs_input" | "blocked" | "stalled" | "timeout" | "resumable_failure";
  reason: string;
  lastCommand?: string;
  resume?: {
    tool: "mimo_resume";
    jobId: string;
  };
}

export interface CompactJobResult {
  status: JobStatus;
  changedFiles: string[];
  tests: CompactAcceptanceResult[];
  failure: CompactFailure | null;
  reportPath: string | null;
  summary?: string;
  attention?: CompactAttention;
}

export interface StandardJobResult extends CompactJobResult {
  jobId: string;
  kind: JobKind;
  parentJobId: string | null;
  resultType: "partial" | "final";
  summary: string;
  phase?: JobPhase;
  elapsedMs: number | null;
  sessionId: string | null;
  keyError?: string;
  completedSlices?: number;
  remainingSlices?: number;
  incomplete?: string[];
  verification: JobVerification[];
  executionCallback?: ExecutionCallbackSummary;
  error?: string;
  errorCode?: string;
  reportPaths?: JobReportPaths;
  notification?: JobNotificationStatus;
  actions: {
    status: "mimo_status";
    events: "mimo_events";
    resume?: "mimo_resume";
  };
}

export interface FullArtifactTooLarge {
  code: "artifact_too_large";
  artifact: "output" | "plan" | "verification" | "job_log" | "diff";
  path: string;
  bytes: number;
}

export interface FullJobResult extends StandardJobResult {
  output?: string;
  plan?: string;
  verificationDetails?: JobVerificationDetails[];
  jobLog?: string;
  diff?: string;
  artifactErrors?: FullArtifactTooLarge[];
}

export interface CompactJobStatus {
  status: JobStatus;
  resultAvailable?: true;
}

export type RenderedJobResult = CompactJobResult | StandardJobResult | FullJobResult;
export type RenderedJobStatus = CompactJobStatus | JobStatusResult;
```

Keep the existing `JobResult` interface unchanged until Task 4 migrates its renderer and call sites;
otherwise Task 1 would make the current implementation fail type checking between review gates. Do
not add `stalled` to `JobStatus` in this phase. It appears only in the future-compatible attention
union.

- [ ] **Step 4: Add the Zod level schema**

In `src/codex/tool-schemas.ts`, add and use:

```ts
export const JobOutputLevelSchema = z.enum(["compact", "standard", "full"]);

export const JobStatusInput = z.object({
  cwd: z.string().min(1),
  jobId: z.string().optional(),
  level: JobOutputLevelSchema.default("compact")
}).strict();

export const JobResultInput = z.object({
  cwd: z.string().min(1),
  jobId: z.string().optional(),
  level: JobOutputLevelSchema.default("compact")
}).strict();
```

- [ ] **Step 5: Accept the new report path fields**

Replace `isOptionalReportPaths()` in `src/core/job-store.ts` with:

```ts
function isOptionalReportPaths(value: unknown): boolean {
  if (value === undefined) return true;
  return isRecord(value) &&
    isOptionalString(value.json) &&
    isOptionalString(value.markdown) &&
    isOptionalString(value.eventsJsonl) &&
    isOptionalString(value.diff) &&
    isOptionalString(value.result) &&
    isOptionalString(value.plan) &&
    isOptionalString(value.verification);
}
```

- [ ] **Step 6: Extend plugin validation to cover level-bearing control schemas**

In `scripts/validate-plugin.mjs`, add:

```js
const OUTPUT_LEVEL_SCHEMA = {
  type: "string",
  enum: ["compact", "standard", "full"],
  default: "compact"
};

function canonicalControlSchema() {
  return {
    type: "object",
    properties: {
      cwd: STRING_SCHEMA,
      jobId: { type: "string" },
      level: OUTPUT_LEVEL_SCHEMA
    },
    required: ["cwd"],
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#"
  };
}

const CANONICAL_LEVEL_CONTROL_SCHEMAS = {
  mimo_status: canonicalControlSchema(),
  mimo_result: canonicalControlSchema()
};
```

Compare both maps during `tools/list` validation:

```js
const canonicalSchemas = {
  ...CANONICAL_WORK_TOOL_SCHEMAS,
  ...CANONICAL_LEVEL_CONTROL_SCHEMAS
};
for (const [name, expectedSchema] of Object.entries(canonicalSchemas)) {
  const tool = tools.find((candidate) => candidate?.name === name);
  if (stableJson(tool?.inputSchema) !== stableJson(expectedSchema)) {
    errors.push(`${name} input schema must match the canonical contract`);
  }
}
```

Mirror `OUTPUT_LEVEL_SCHEMA`, `canonicalControlSchema()`, and
`CANONICAL_LEVEL_CONTROL_SCHEMAS` in the validator fixture as:

```ts
const outputLevel = {
  type: "string",
  enum: ["compact", "standard", "full"],
  default: "compact"
};
const controlSchema = {
  type: "object",
  properties: {
    cwd: string,
    jobId: { type: "string" },
    level: outputLevel
  },
  required: ["cwd"],
  additionalProperties: false,
  $schema: "http://json-schema.org/draft-07/schema#"
};
const CONTROL_SCHEMAS: Record<string, Record<string, unknown>> = {
  mimo_status: controlSchema,
  mimo_result: structuredClone(controlSchema)
};
```

Construct fixture tools with:

```ts
inputSchema: structuredClone(
  WORK_SCHEMAS[name] ??
  CONTROL_SCHEMAS[name] ??
  { type: "object", properties: {} }
)
```

- [ ] **Step 7: Run focused tests and type checking**

Run:

```powershell
npm.cmd test -- tool-schemas.test.ts job-store.test.ts plugin-validator.test.ts
npm.cmd run lint
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 8: Conditional commit checkpoint**

Only if the user explicitly requested commits:

```powershell
git add src/core/jobs.ts src/codex/tool-schemas.ts src/core/job-store.ts scripts/validate-plugin.mjs test/unit/tool-schemas.test.ts test/unit/job-store.test.ts test/unit/plugin-validator.test.ts
git commit -m "feat(results): define compact output contracts"
```

### Task 2: Persist structural and semantic delivery artifacts

**Files:**
- Create: `src/core/job-artifacts.ts`
- Create: `test/unit/core/job-artifacts.test.ts`
- Modify: `src/core/job-output.ts:1-12`
- Modify: `test/unit/core/job-output.test.ts:1-69`

**Interfaces:**
- Produces: `summarizeJobOutput(output, maxChars?)`, `redactDiagnosticText(text)`, `readTextArtifact(path)`, `readSavedJobOutput(job)`, `readVerificationArtifact(path)`, `readKeyVerificationError(path)`, and `readJobDiagnostics(job, fallbackOutput?)`.
- Produces: `artifact_too_large` references with exact paths for diagnostic artifacts above 1,000,000 bytes; it never silently truncates them.
- Produces: `writeJobArtifacts(input): JobReportPaths`.
- Consumes: `JobRecord`, `JobStatus`, `JobVerificationDetails`, and optional existing Compose report paths.

- [ ] **Step 1: Write failing output-helper tests**

Extend `test/unit/core/job-output.test.ts`:

```ts
import {
  FULL_ARTIFACT_MAX_BYTES,
  readFinalJobOutput,
  readJobDiagnostics,
  readKeyVerificationError,
  readSavedJobOutput,
  readTextArtifact,
  redactDiagnosticText,
  summarizeJobOutput
} from "../../../src/core/job-output.js";
import type { JobRecord } from "../../../src/core/jobs.js";

it("extracts a bounded semantic summary after a Markdown heading", () => {
  const output = "# Complete plan\n\nImplement the callback in three focused steps.\n\n## Details\n...";
  expect(summarizeJobOutput(output)).toBe("Implement the callback in three focused steps.");
});

it("prefers an explicit final summary section", () => {
  const output = "# Plan\n\nLong introduction.\n\n## Summary\n\nUse the compact delivery path.";
  expect(summarizeJobOutput(output)).toBe("Use the compact delivery path.");
});

it("redacts credentials before returning a semantic summary", () => {
  expect(summarizeJobOutput("# Plan\n\nUse token=private for the request."))
    .toBe("Use token=[REDACTED] for the request.");
});

it("caps semantic summaries at 500 characters", () => {
  expect(summarizeJobOutput("x".repeat(700))).toHaveLength(500);
});

it("reads an optional text artifact without throwing", () => {
  const file = tempFile("artifact body");
  expect(readTextArtifact(file)).toBe("artifact body");
  expect(readTextArtifact(`${file}.missing`)).toBeUndefined();
});

it("prefers the saved result artifact over reparsing legacy events", () => {
  const resultFile = tempFile("saved result");
  expect(readSavedJobOutput({
    reportPaths: { result: resultFile },
    eventsFile: `${resultFile}.missing`
  } as JobRecord)).toBe("saved result");
});

it("redacts recognized credentials from explicit full diagnostics", () => {
  expect(redactDiagnosticText(
    "Authorization: Bearer secret-token token=abc123 --password hunter2 " +
      "https://example.test/?api_key=url-secret ghp_abcdefghijklmnopqrstuvwxyz"
  )).toBe(
    "Authorization: Bearer [REDACTED] token=[REDACTED] --password [REDACTED] " +
      "https://example.test/?api_key=[REDACTED] [REDACTED]"
  );
});

it("returns artifact_too_large with the exact path instead of truncating", () => {
  const resultFile = tempFile("x".repeat(FULL_ARTIFACT_MAX_BYTES + 1));
  const job = {
    id: "plan-legacy",
    kind: "plan",
    cwd: path.dirname(resultFile),
    task: "plan",
    request: {},
    status: "completed",
    processIdentity: null,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:01.000Z",
    changedFiles: [],
    verification: [],
    reportPaths: { result: resultFile },
    logFile: `${resultFile}.log`,
    eventsFile: `${resultFile}.events`,
    signalsFile: `${resultFile}.signals`,
    notificationOutboxFile: `${resultFile}.outbox`
  } satisfies JobRecord;

  const diagnostics = readJobDiagnostics(job);
  expect(diagnostics).not.toHaveProperty("output");
  expect(diagnostics.artifactErrors).toEqual([{
    code: "artifact_too_large",
    artifact: "output",
    path: resultFile,
    bytes: FULL_ARTIFACT_MAX_BYTES + 1
  }]);
});

it("extracts one bounded and redacted standard verification error", () => {
  const file = tempFile(JSON.stringify([{
    command: "npm test",
    exitCode: 1,
    passed: false,
    stdout: "",
    stderr: `token=private ${"failure ".repeat(100)}`
  }]));
  const excerpt = readKeyVerificationError(file)!;
  expect(excerpt).toContain("token=[REDACTED]");
  expect(excerpt).toHaveLength(500);
});
```

- [ ] **Step 2: Write the failing artifact-writer test**

Create `test/unit/core/job-artifacts.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeJobArtifacts } from "../../../src/core/job-artifacts.js";
import type { JobRecord } from "../../../src/core/jobs.js";

const roots: string[] = [];

function root(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-artifacts-"));
  roots.push(cwd);
  return cwd;
}

function planJob(cwd: string): JobRecord {
  return {
    id: "plan-1",
    kind: "plan",
    cwd,
    task: "private objective",
    request: { privatePrompt: "PRIVATE_PROMPT" },
    status: "completed",
    processIdentity: null,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:01.000Z",
    changedFiles: [],
    verification: [],
    logFile: path.join(cwd, "job.log"),
    eventsFile: path.join(cwd, "events.jsonl"),
    signalsFile: path.join(cwd, "signals.jsonl"),
    notificationOutboxFile: path.join(cwd, "notifications.jsonl")
  };
}

afterEach(() => {
  for (const cwd of roots.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

describe("writeJobArtifacts", () => {
  it("separates structural reports from complete semantic and verification artifacts", () => {
    const cwd = root();
    const finalText = "# Plan\n\nComplete plan body with token=artifact-secret.";
    const safeFinalText = "# Plan\n\nComplete plan body with token=[REDACTED]";
    const stdout = "TEST_STDOUT token=verification-secret";
    const safeStdout = "TEST_STDOUT token=[REDACTED]";
    const diff = "diff --git a/src/a.ts b/src/a.ts\n+token=diff-secret";
    const paths = writeJobArtifacts({
      job: planJob(cwd),
      status: "completed",
      changedFiles: [],
      verification: [{
        command: "npm test",
        exitCode: 0,
        passed: true,
        durationMs: 12,
        stdout,
        stderr: ""
      }],
      finalText,
      diff,
      plan: true
    });

    expect(fs.readFileSync(paths.result!, "utf8")).toBe(safeFinalText);
    expect(fs.readFileSync(paths.plan!, "utf8")).toBe(safeFinalText);
    expect(fs.readFileSync(paths.verification!, "utf8")).toContain(safeStdout);
    expect(fs.readFileSync(paths.verification!, "utf8")).not.toContain("verification-secret");
    expect(fs.readFileSync(paths.diff!, "utf8")).toContain("token=[REDACTED]");
    expect(fs.readFileSync(paths.diff!, "utf8")).not.toContain("diff-secret");

    const structuralJson = fs.readFileSync(paths.json!, "utf8");
    const structuralMarkdown = fs.readFileSync(paths.markdown!, "utf8");
    for (const structural of [structuralJson, structuralMarkdown]) {
      expect(structural).not.toContain(finalText);
      expect(structural).not.toContain(stdout);
      expect(structural).not.toContain("diff --git");
      expect(structural).not.toContain("PRIVATE_PROMPT");
    }
    expect(JSON.parse(structuralJson).reportPaths).toMatchObject({
      result: paths.result,
      plan: paths.plan,
      verification: paths.verification
    });
  });
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```powershell
npm.cmd test -- job-output.test.ts job-artifacts.test.ts
```

Expected: FAIL because the helper exports and artifact writer do not exist.

- [ ] **Step 4: Implement output reading, summary extraction, and redaction**

Keep `readFinalJobOutput()` and add to `src/core/job-output.ts`:

```ts
import type {
  FullArtifactTooLarge,
  FullJobResult,
  JobRecord,
  JobVerificationDetails
} from "./jobs.js";

export const OUTPUT_SUMMARY_MAX_CHARS = 500;
export const FULL_ARTIFACT_MAX_BYTES = 1_000_000;

export function summarizeJobOutput(
  output: string | undefined,
  maxChars = OUTPUT_SUMMARY_MAX_CHARS
): string | undefined {
  const lines = output
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines || lines.length === 0) return undefined;

  const explicitSummary = lines.findIndex((line) =>
    /^#{1,6}\s+(?:summary|result|摘要|总结)\s*$/i.test(line));
  const substantive = (explicitSummary >= 0
    ? lines.slice(explicitSummary + 1).find((line) => !/^#{1,6}\s+/.test(line))
    : undefined) ??
    lines.find((line) => !/^#{1,6}\s+/.test(line)) ??
    lines[0];
  const sentence = substantive.match(/^.*?[.!?。！？](?:\s|$)/)?.[0] ?? substantive;
  const singleLine = sentence
    .replace(/^[-*+]\s+/, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return singleLine
    ? redactDiagnosticText(singleLine).slice(0, maxChars)
    : undefined;
}

export function readTextArtifact(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export function readSavedJobOutput(job: JobRecord): string | undefined {
  return readTextArtifact(job.reportPaths?.result) ?? readFinalJobOutput(job.eventsFile);
}

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:--)(?:api[_-]?key|token|password|secret)(?:=|\s+))([^\s"'`]+)/gi,
      "$1[REDACTED]"
    )
    .replace(
      /([?&](?:api[_-]?key|token|password|secret)=)([^&\s]+)/gi,
      "$1[REDACTED]"
    )
    .replace(
      /\b(?:ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g,
      "[REDACTED]"
    )
    .replace(
      /((?:api[_-]?key|token|password|secret)\s*[:=]\s*)([^\s"'`]+)/gi,
      "$1[REDACTED]"
    );
}

export function readVerificationArtifact(
  file: string | undefined
): JobVerificationDetails[] | undefined {
  const raw = readTextArtifact(file);
  return raw ? parseVerificationArtifact(raw) : undefined;
}

export function readKeyVerificationError(file: string | undefined): string | undefined {
  const read = readDiagnosticArtifact(file, "verification");
  if (!read.content) return undefined;
  const failed = parseVerificationArtifact(read.content)?.find((result) => !result.passed);
  const evidence = failed?.stderr.trim() || failed?.stdout.trim();
  return evidence
    ? redactDiagnosticText(evidence)
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500)
    : undefined;
}

function parseVerificationArtifact(raw: string): JobVerificationDetails[] | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const results = parsed.filter((entry): entry is JobVerificationDetails =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as JobVerificationDetails).command === "string" &&
      ((entry as JobVerificationDetails).exitCode === null ||
        Number.isInteger((entry as JobVerificationDetails).exitCode)) &&
      typeof (entry as JobVerificationDetails).passed === "boolean" &&
      typeof (entry as JobVerificationDetails).stdout === "string" &&
      typeof (entry as JobVerificationDetails).stderr === "string" &&
      ((entry as JobVerificationDetails).durationMs === undefined ||
        (typeof (entry as JobVerificationDetails).durationMs === "number" &&
          (entry as JobVerificationDetails).durationMs! >= 0))
    );
    return results.length === parsed.length ? results : undefined;
  } catch {
    return undefined;
  }
}

export function readJobDiagnostics(
  job: JobRecord,
  fallbackOutput?: string
): Pick<
  FullJobResult,
  "output" | "plan" | "verificationDetails" | "jobLog" | "diff" | "artifactErrors"
> {
  const errors: FullArtifactTooLarge[] = [];
  const outputRead = job.reportPaths?.result
    ? readDiagnosticArtifact(job.reportPaths.result, "output")
    : readDiagnosticFallback(fallbackOutput, job.eventsFile, "output");
  const planRead = readDiagnosticArtifact(job.reportPaths?.plan, "plan");
  const verificationRead = readDiagnosticArtifact(
    job.reportPaths?.verification,
    "verification"
  );
  const jobLogRead = readDiagnosticArtifact(job.logFile, "job_log");
  const diffRead = readDiagnosticArtifact(job.reportPaths?.diff, "diff");
  for (const read of [outputRead, planRead, verificationRead, jobLogRead, diffRead]) {
    if (read.error) errors.push(read.error);
  }

  const verificationDetails = verificationRead.content
    ? parseVerificationArtifact(verificationRead.content)?.map((result) => ({
        ...result,
        command: redactDiagnosticText(result.command),
        stdout: redactDiagnosticText(result.stdout),
        stderr: redactDiagnosticText(result.stderr)
      }))
    : undefined;
  return {
    ...(outputRead.content ? { output: redactDiagnosticText(outputRead.content) } : {}),
    ...(planRead.content ? { plan: redactDiagnosticText(planRead.content) } : {}),
    ...(verificationDetails ? { verificationDetails } : {}),
    ...(jobLogRead.content ? { jobLog: redactDiagnosticText(jobLogRead.content) } : {}),
    ...(diffRead.content ? { diff: redactDiagnosticText(diffRead.content) } : {}),
    ...(errors.length > 0 ? { artifactErrors: errors } : {})
  };
}

interface DiagnosticArtifactRead {
  content?: string;
  error?: FullArtifactTooLarge;
}

function readDiagnosticArtifact(
  file: string | undefined,
  artifact: FullArtifactTooLarge["artifact"]
): DiagnosticArtifactRead {
  if (!file) return {};
  try {
    const bytes = fs.statSync(file).size;
    if (bytes > FULL_ARTIFACT_MAX_BYTES) {
      return {
        error: { code: "artifact_too_large", artifact, path: file, bytes }
      };
    }
    return { content: fs.readFileSync(file, "utf8") };
  } catch {
    return {};
  }
}

function readDiagnosticFallback(
  content: string | undefined,
  path: string,
  artifact: FullArtifactTooLarge["artifact"]
): DiagnosticArtifactRead {
  if (!content) return {};
  const bytes = Buffer.byteLength(content, "utf8");
  return bytes > FULL_ARTIFACT_MAX_BYTES
    ? { error: { code: "artifact_too_large", artifact, path, bytes } }
    : { content };
}
```

- [ ] **Step 5: Implement the artifact writer**

Create `src/core/job-artifacts.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { redactDiagnosticText } from "./job-output.js";
import { publicProgressSummary } from "./public-summary.js";
import type {
  JobRecord,
  JobReportPaths,
  JobStatus,
  JobVerification,
  JobVerificationDetails
} from "./jobs.js";

export interface WriteJobArtifactsInput {
  job: JobRecord;
  status: JobStatus;
  errorCode?: string;
  changedFiles: string[];
  verification: JobVerificationDetails[];
  compactVerification?: JobVerification[];
  finalText: string;
  diff?: string;
  plan: boolean;
  reportDir?: string;
  diffsDir?: string;
  existingReportPaths?: JobReportPaths;
}

export function writeJobArtifacts(input: WriteJobArtifactsInput): JobReportPaths {
  const reportDir = input.reportDir ??
    path.join(input.job.cwd, ".codex-mimo", "reports");
  const diffsDir = input.diffsDir ??
    path.join(input.job.cwd, ".codex-mimo", "diffs");
  fs.mkdirSync(reportDir, { recursive: true });

  const finalText = redactDiagnosticText(input.finalText.trim());
  const result = finalText
    ? path.join(reportDir, `${input.job.id}.result.md`)
    : undefined;
  const plan = input.plan && finalText
    ? path.join(reportDir, `${input.job.id}.plan.md`)
    : undefined;
  const verification = input.verification.length > 0
    ? path.join(reportDir, `${input.job.id}.verification.json`)
    : undefined;
  const diffText = input.diff?.trim()
    ? redactDiagnosticText(input.diff.trim())
    : undefined;
  const diffPath = input.existingReportPaths?.diff ??
    (diffText ? path.join(diffsDir, `${input.job.id}.diff`) : undefined);
  const reportPaths: JobReportPaths = {
    ...input.existingReportPaths,
    json: input.existingReportPaths?.json ??
      path.join(reportDir, `${input.job.id}.json`),
    markdown: input.existingReportPaths?.markdown ??
      path.join(reportDir, `${input.job.id}.md`),
    ...(result ? { result } : {}),
    ...(plan ? { plan } : {}),
    ...(verification ? { verification } : {}),
    ...(diffPath ? { diff: diffPath } : {})
  };

  if (result) fs.writeFileSync(result, finalText, "utf8");
  if (plan) fs.writeFileSync(plan, finalText, "utf8");
  if (verification) {
    const safeVerification = input.verification.map((entry) => ({
      ...entry,
      command: redactDiagnosticText(entry.command),
      stdout: redactDiagnosticText(entry.stdout),
      stderr: redactDiagnosticText(entry.stderr)
    }));
    fs.writeFileSync(verification, JSON.stringify(safeVerification, null, 2), "utf8");
  }
  if (diffText && !input.existingReportPaths?.diff && diffPath) {
    fs.mkdirSync(path.dirname(diffPath), { recursive: true });
    fs.writeFileSync(diffPath, diffText, "utf8");
  }

  const compactVerification: JobVerification[] = (
    input.compactVerification ??
    input.verification
  ).map(({ command, exitCode, passed, durationMs }) => ({
    command: redactDiagnosticText(command).slice(0, 240),
    exitCode,
    passed,
    ...(durationMs === undefined ? {} : { durationMs })
  }));
  const summary = publicProgressSummary({
    type: "job",
    status: input.status,
    ...(input.errorCode ? { errorCode: input.errorCode } : {})
  });
  const structural = {
    version: 1,
    id: input.job.id,
    createdAt: input.job.createdAt,
    kind: input.job.kind,
    status: input.status,
    summary,
    changedFiles: [...input.changedFiles],
    verification: compactVerification,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    reportPaths
  };

  if (!input.existingReportPaths?.json) {
    fs.writeFileSync(reportPaths.json!, JSON.stringify(structural, null, 2), "utf8");
  }
  if (!input.existingReportPaths?.markdown) {
    const changedFiles = input.changedFiles.length > 0
      ? input.changedFiles.map((file) => `- \`${file}\``)
      : ["No changed files detected."];
    const checks = compactVerification.length > 0
      ? compactVerification.map((check) =>
          `- ${check.passed ? "PASS" : "FAIL"} \`${check.command}\``)
      : ["No verification commands were run."];
    const markdown = [
      "# Codex-MiMo Job Report",
      "",
      `Job: \`${input.job.id}\``,
      `Kind: \`${input.job.kind}\``,
      `Status: \`${input.status}\``,
      `Summary: ${summary}`,
      "",
      "## Changed Files",
      "",
      ...changedFiles,
      "",
      "## Verification",
      "",
      ...checks,
      "",
      "## Artifact Paths",
      "",
      ...(result ? [`- Result: \`${result}\``] : []),
      ...(plan ? [`- Plan: \`${plan}\``] : []),
      ...(verification ? [`- Verification: \`${verification}\``] : []),
      ...(diffPath ? [`- Diff: \`${diffPath}\``] : []),
      ""
    ].join("\n");
    fs.writeFileSync(reportPaths.markdown!, markdown, "utf8");
  }

  return reportPaths;
}
```

- [ ] **Step 6: Run artifact tests**

Run:

```powershell
npm.cmd test -- job-output.test.ts job-artifacts.test.ts
```

Expected: PASS. Structural files omit full text and verification output; semantic files contain them.

- [ ] **Step 7: Conditional commit checkpoint**

Only if explicitly authorized:

```powershell
git add src/core/job-output.ts src/core/job-artifacts.ts test/unit/core/job-output.test.ts test/unit/core/job-artifacts.test.ts
git commit -m "feat(results): persist delivery artifacts"
```

### Task 3: Attach artifact writing to direct and Compose finalization

**Files:**
- Modify: `src/core/job-definitions.ts:118-125,370-496`
- Modify: `src/core/job-transition.ts:54-100`
- Modify: `src/compose/report.ts:11-38,113-117,331-343`
- Modify: `test/unit/core/job-definitions.test.ts:260-326,443-526`
- Modify: `test/unit/core/job-transition.test.ts`
- Modify: `test/unit/compose-report.test.ts:11-77`

**Interfaces:**
- Consumes: `writeJobArtifacts(input): JobReportPaths`.
- Produces: every direct and Compose outcome carries structural `json`/`markdown`, optional `result`, optional `plan`, optional `verification`, and existing events/diff paths.
- Produces: fallback structural reports for cancellation/recovery transitions that bypass normal finalizers.
- Preserves: `classifyRunOutcome`, read-only violation overlay, and full `VerificationResult[]` until after artifact writing.

- [ ] **Step 1: Write failing direct and Compose finalization tests**

Add to `test/unit/core/job-definitions.test.ts`:

```ts
it("writes direct plan artifacts after outcome classification", async () => {
  const cwd = tempDir();
  const request: JobRequestByKind["plan"] = { cwd, task: "plan it" };
  const outcome = await getJobDefinition("plan").finalize({
    signal: ACTIVE_SIGNAL,
    job: makeJob("plan", request),
    request,
    run: { stdout: "", stderr: "", exitCode: 0, pid: 1 },
    events: [{ type: "message", text: "# Plan\n\nFirst step.", raw: {} }],
    executionCallback: { invocationId: "inv", outcome: "completed" },
    verification: []
  });

  expect(outcome.reportPaths).toMatchObject({
    json: expect.any(String),
    markdown: expect.any(String),
    result: expect.any(String),
    plan: expect.any(String)
  });
  expect(fs.readFileSync(outcome.reportPaths!.plan!, "utf8")).toBe("# Plan\n\nFirst step.");
  expect(fs.readFileSync(outcome.reportPaths!.markdown!, "utf8")).not.toContain("First step.");
});

it("persists full Compose verification separately from the compact job record", async () => {
  const cwd = tempDir();
  const request: JobRequestByKind["compose"] = {
    cwd,
    workflow: "dev",
    task: "build it",
    verification: ["npm test"]
  };
  const outcome = await getJobDefinition("compose").finalize({
    signal: ACTIVE_SIGNAL,
    job: makeJob("compose", request),
    request,
    run: { stdout: "", stderr: "", exitCode: 0, pid: 1 },
    events: [{ type: "message", text: "done", raw: {} }],
    executionCallback: { invocationId: "inv", outcome: "completed" },
    verification: [],
    deps: {
      runVerification: async () => [{
        command: "npm test",
        exitCode: 0,
        stdout: "FULL_STDOUT",
        stderr: "",
        passed: true,
        durationMs: 5
      }]
    }
  });

  expect(outcome.verification).toEqual([{
    command: "npm test",
    exitCode: 0,
    passed: true,
    durationMs: 5
  }]);
  expect(fs.readFileSync(outcome.reportPaths!.verification!, "utf8")).toContain("FULL_STDOUT");
  const structural = fs.readFileSync(outcome.reportPaths!.json!, "utf8");
  expect(structural).not.toContain("FULL_STDOUT");
  expect(structural).toContain(outcome.reportPaths!.verification!);
});
```

In the existing direct-implement finalization case, change `context.diff.diff` from `""` to
`"diff"` and add:

```ts
expect(outcome.reportPaths).toMatchObject({
  result: expect.any(String),
  diff: expect.any(String)
});
expect(fs.readFileSync(outcome.reportPaths!.diff!, "utf8")).toBe("diff");
```

Add to `test/unit/compose-report.test.ts`:

```ts
it("keeps full verification output only in the verification artifact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-report-verification-"));
  try {
    const report = createComposeReport({
      id: "verification-report",
      createdAt: "2026-07-26T00:00:00.000Z",
      workflow: "dev",
      cwd: root,
      requestedSkills: ["compose:verify"],
      status: "failed",
      events: [],
      diff: { changedFiles: [], diffStat: "", diff: "" },
      verification: [{
        command: "npm test",
        exitCode: 1,
        passed: false,
        durationMs: 10,
        stdout: "FULL_STDOUT",
        stderr: "FULL_STDERR"
      }],
      reportDir: path.join(root, "reports"),
      eventsDir: path.join(root, "events"),
      diffsDir: path.join(root, "diffs")
    });
    writeComposeReport(report);

    expect(report.verification).toEqual([{
      command: "npm test",
      exitCode: 1,
      passed: false,
      durationMs: 10
    }]);
    expect(fs.readFileSync(report.reportPaths.json, "utf8")).not.toMatch(
      /FULL_STDOUT|FULL_STDERR/
    );
    expect(fs.readFileSync(report.reportPaths.markdown, "utf8")).not.toMatch(
      /FULL_STDOUT|FULL_STDERR/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

Update the existing “finalizes each kind without mutating the stored job” test so its temp workspace is retained and it additionally expects:

```ts
expect(outcome.reportPaths).toMatchObject({
  json: expect.any(String),
  markdown: expect.any(String),
  result: expect.any(String)
});
```

Add to `test/unit/core/job-transition.test.ts`:

```ts
it("writes a fallback structural report for terminal transitions without a finalizer", async () => {
  const { cwd, jobId } = seedJob("queued");

  const transitioned = await transitionJob(cwd, jobId, {
    status: "cancelled",
    summary: "Cancelled.",
    errorCode: "cancelled"
  });

  expect(transitioned.job.reportPaths).toMatchObject({
    json: expect.any(String),
    markdown: expect.any(String)
  });
  expect(fs.existsSync(transitioned.job.reportPaths!.json!)).toBe(true);
  expect(fs.existsSync(transitioned.job.reportPaths!.markdown!)).toBe(true);
});
```

- [ ] **Step 2: Run finalization tests and verify failure**

Run:

```powershell
npm.cmd test -- job-definitions.test.ts job-transition.test.ts compose-report.test.ts
```

Expected: FAIL because direct/cancellation paths have no report paths and Compose drops stdout/stderr before artifact persistence.

- [ ] **Step 3: Add injectable artifact writing**

In `src/core/job-definitions.ts`, import `writeJobArtifacts` and extend dependencies:

```ts
import {
  writeJobArtifacts,
  type WriteJobArtifactsInput
} from "./job-artifacts.js";

export interface JobFinalizeDependencies {
  runVerification?: (
    cwd: string,
    commands: string[],
    options?: VerificationRunOptions
  ) => Promise<VerificationResult[]>;
  writeComposeReport?: (report: ComposeReport) => void;
  writeJobArtifacts?: (input: WriteJobArtifactsInput) => JobReportPaths;
}
```

Also import `JobReportPaths` from `./jobs.js`.

- [ ] **Step 4: Rewrite direct finalization to avoid an early return before artifacts**

Replace the read-only branch and return in `finalizeDirect()` with:

```ts
let finalOutcome = outcome;
if (!writesAllowed && hasReadOnlyViolation(context, changedFiles)) {
  const error = readOnlyViolationError(
    context.job.kind,
    changedFiles,
    context.gitHeadBefore,
    context.gitHeadAfter
  );
  if (!outcome.errorCode?.startsWith("callback_")) {
    finalOutcome = {
      ...outcome,
      status: "failed",
      summary: error,
      changedFiles,
      error,
      errorCode: "read_only_violation"
    };
  }
}

const writeArtifacts = context.deps?.writeJobArtifacts ?? writeJobArtifacts;
const reportPaths = writeArtifacts({
  job: context.job,
  status: finalOutcome.status,
  ...(finalOutcome.errorCode ? { errorCode: finalOutcome.errorCode } : {}),
  changedFiles,
  verification,
  finalText: finalTextFrom(context),
  ...(context.diff?.diff ? { diff: context.diff.diff } : {}),
  plan: context.job.kind === "plan"
});

return {
  ...finalOutcome,
  changedFiles,
  verification: compactVerification(verification),
  reportPaths
};
```

- [ ] **Step 5: Merge semantic paths into the Compose report before writing it**

After `createComposeReport()` and before `writeComposeReport()` in `finalizeCompose()`, build the base paths and write artifacts:

```ts
const baseReportPaths: JobReportPaths = {
  json: report.reportPaths.json,
  markdown: report.reportPaths.markdown,
  eventsJsonl: report.reportPaths.eventsJsonl,
  ...(report.diffPath ? { diff: report.diffPath } : {})
};
const writeArtifacts = context.deps?.writeJobArtifacts ?? writeJobArtifacts;
const reportPaths = writeArtifacts({
  job: context.job,
  status: outcome.status,
  ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
  changedFiles,
  verification,
  finalText: finalTextFrom(context),
  plan: workflow.name === "plan",
  reportDir: context.request.reportDir ??
    path.join(context.request.cwd, ".codex-mimo", "reports"),
  existingReportPaths: baseReportPaths
});

report.reportPaths = {
  json: report.reportPaths.json,
  markdown: report.reportPaths.markdown,
  eventsJsonl: report.reportPaths.eventsJsonl,
  ...(reportPaths.result ? { result: reportPaths.result } : {}),
  ...(reportPaths.plan ? { plan: reportPaths.plan } : {}),
  ...(reportPaths.verification ? { verification: reportPaths.verification } : {})
};
context.signal.throwIfAborted();
(context.deps?.writeComposeReport ?? writeComposeReport)(report);

return {
  ...outcome,
  changedFiles,
  verification: compactVerification(verification),
  reportPaths
};
```

Remove the old duplicated `writeComposeReport()` call and old literal `reportPaths` return.

- [ ] **Step 6: Add a transition fallback for terminal paths that bypass finalizers**

In `src/core/job-transition.ts`, import `readSavedJobOutput`, `writeJobArtifacts`, and its input
type. Extend dependencies:

```ts
export interface JobTransitionDependencies {
  afterIntentPersisted?: () => Promise<void> | void;
  afterSignalAppended?: () => Promise<void> | void;
  afterJobFinalized?: () => Promise<void> | void;
  afterDeliveryEnqueued?: () => Promise<void> | void;
  afterIntentCleared?: () => Promise<void> | void;
  appendSignal?: typeof appendJobSignalAtCursor;
  enqueueDelivery?: typeof enqueueNotificationDelivery;
  writeJobArtifacts?: (input: WriteJobArtifactsInput) => JobReportPaths;
}
```

Before pending-transition comparison, normalize the requested transition:

```ts
let existing = requireJob(cwd, jobId);
const requested = ensureTransitionArtifacts(existing, transition, dependencies);
if (existing.pendingTransition) {
  const sameRequest = pendingMatchesRequest(existing.pendingTransition, requested);
  const recovered = await applyPendingTransition(
    cwd,
    existing,
    existing.pendingTransition,
    dependencies
  );
  if (sameRequest) return recovered;
  existing = recovered.job;
}

if (!LEGAL[existing.status].includes(requested.status)) {
  throw new Error(`Illegal job transition ${existing.status} -> ${requested.status}`);
}
if (existing.cancellationRequestedAt && requested.status !== "cancelled") {
  throw new Error(`Job ${jobId} cancellation was requested; only cancellation may finalize it.`);
}

const pending = buildPendingTransition(existing, requested);
```

Add the deterministic helper:

```ts
function ensureTransitionArtifacts(
  job: JobRecord,
  transition: JobTransition,
  dependencies: JobTransitionDependencies
): JobTransition {
  if (transition.status === "running" || transition.reportPaths) return transition;
  const writeArtifacts = dependencies.writeJobArtifacts ?? writeJobArtifacts;
  const workflow = typeof job.request === "object" && job.request !== null
    ? (job.request as Record<string, unknown>).workflow
    : undefined;
  const reportDir = typeof job.request === "object" &&
    job.request !== null &&
    typeof (job.request as Record<string, unknown>).reportDir === "string"
    ? (job.request as Record<string, unknown>).reportDir as string
    : undefined;
  const reportPaths = writeArtifacts({
    job,
    status: transition.status,
    ...(transition.errorCode ? { errorCode: transition.errorCode } : {}),
    changedFiles: transition.changedFiles ?? job.changedFiles,
    verification: [],
    compactVerification: transition.verification ?? job.verification,
    finalText: readSavedJobOutput(job) ?? "",
    plan: job.kind === "plan" || (job.kind === "compose" && workflow === "plan"),
    ...(reportDir ? { reportDir } : {}),
    existingReportPaths: transition.reportPaths ?? job.reportPaths
  });
  return { ...transition, reportPaths };
}
```

Preparing artifacts before `pendingMatchesRequest()` is required: retries must hash the same
deterministic report paths as the persisted transition intent.

- [ ] **Step 7: Extend the Compose report path type**

In `src/compose/report.ts`, import `JobReportPaths`, `JobVerification`, and
`redactDiagnosticText`. Change `ComposeReport.verification` from `VerificationResult[]` to
`JobVerification[]`, while `CreateComposeReportInput.verification` remains `VerificationResult[]`.
Define:

```ts
export interface ComposeReportPaths extends JobReportPaths {
  json: string;
  markdown: string;
  eventsJsonl: string;
}
```

Project full verification into the structural report:

```ts
verification: input.verification.map(
  ({ command, exitCode, passed, durationMs }) => ({
    command: redactDiagnosticText(command).slice(0, 240),
    exitCode,
    passed,
    ...(durationMs === undefined ? {} : { durationMs })
  })
),
```

Change `ComposeReport.reportPaths` to `ComposeReportPaths`. Keep structural report rendering unchanged except that its “Report Files” section may append:

```ts
...(report.reportPaths.result ? [`- Result: \`${report.reportPaths.result}\``] : []),
...(report.reportPaths.plan ? [`- Plan: \`${report.reportPaths.plan}\``] : []),
...(report.reportPaths.verification
  ? [`- Verification: \`${report.reportPaths.verification}\``]
  : []),
```

Do not inline any artifact content.
Remove `stdout`/`stderr` from direct `renderMarkdownReport()` fixtures in
`test/unit/compose-report.test.ts`; those fields now belong only to the writer input and
`<jobId>.verification.json`.

- [ ] **Step 8: Run finalization, transition, and report tests**

Run:

```powershell
npm.cmd test -- job-definitions.test.ts job-transition.test.ts compose-report.test.ts
npm.cmd run lint
```

Expected: PASS. Direct jobs now have structural reports; Compose reports link to semantic artifacts; classification and read-only tests remain unchanged.

- [ ] **Step 9: Conditional commit checkpoint**

Only if explicitly authorized:

```powershell
git add src/core/job-definitions.ts src/core/job-transition.ts src/compose/report.ts test/unit/core/job-definitions.test.ts test/unit/core/job-transition.test.ts test/unit/compose-report.test.ts
git commit -m "feat(results): attach artifacts to job outcomes"
```

### Task 4: Implement compact, standard, and full rendering

**Files:**
- Modify: `src/core/job-render.ts:1-168`
- Modify: `src/codex/tools.ts:28-31,249-263,294-377` for compile-preserving call-site migration
- Modify: `src/notify/codex-adapter.ts:1-20` for compile-preserving V1 behavior
- Modify: `test/unit/job-render.test.ts:1-198`
- Modify: `test/unit/core/job-render.test.ts:1-189`

**Interfaces:**
- Produces: `renderCompactJobStatus(job)`, existing `renderJobStatus(job, options)` as standard, `renderCompactJobResult(job, options)`, existing `renderJobResult(job, options)` as standard, and `renderFullJobResult(job, options)`.
- Produces: `isSemanticResultJob(job)` so compact callers read final output only for plan/review summaries.
- Consumes: optional final output for bounded plan/review summary and optional diagnostics for full output.
- Enforces: `COMPACT_RESULT_MAX_BYTES = 6000`.

- [ ] **Step 1: Replace old compact-render tests with explicit level tests**

Add these cases to `test/unit/job-render.test.ts` and move existing observability assertions to standard rendering:

```ts
import {
  COMPACT_RESULT_MAX_BYTES,
  renderCompactJobResult,
  renderCompactJobStatus,
  renderFullJobResult,
  renderJobResult,
  renderJobStatus
} from "../../src/core/job-render.js";

it("renders the heartbeat as one short state", () => {
  expect(renderCompactJobStatus(job())).toEqual({ status: "running" });
  expect(renderCompactJobStatus(job({
    status: "completed",
    phase: undefined
  }))).toEqual({ status: "completed", resultAvailable: true });
});

it("omits output and operator metadata from compact implementation results", () => {
  const result = renderCompactJobResult(job({
    status: "completed",
    phase: undefined,
    reportPaths: { markdown: "report.md", result: "result.md" },
    verification: [{ command: "npm test --token private", exitCode: 0, passed: true }]
  }), { output: "PRIVATE COMPLETE OUTPUT" });

  expect(result).toEqual({
    status: "completed",
    changedFiles: ["src/login.ts"],
    tests: [{
      stage: "test",
      command: "npm test --token [REDACTED]",
      outcome: "passed"
    }],
    failure: null,
    reportPath: "report.md"
  });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|session|notification|actions|output/);
});

it("adds only a bounded semantic summary for planning results", () => {
  const result = renderCompactJobResult(job({
    kind: "plan",
    status: "completed",
    phase: undefined,
    changedFiles: [],
    reportPaths: { markdown: "report.md", plan: "plan.md" }
  }), { output: "# Plan\n\nImplement three focused steps." });

  expect(result.summary).toBe("Implement three focused steps.");
  expect(result.reportPath).toBe("plan.md");
  expect(result).not.toHaveProperty("output");
});

it("keeps representative English and Chinese compact results within budget", () => {
  for (const output of [
    "# Plan\n\nImplement the smallest safe callback change.",
    "# 方案\n\n按三个小批次实现紧凑回传并保存完整报告。"
  ]) {
    const result = renderCompactJobResult(job({
      kind: "plan",
      status: "failed",
      phase: undefined,
      changedFiles: Array.from({ length: 200 }, (_, index) => `src/very-long-file-${index}.ts`),
      verification: Array.from({ length: 50 }, (_, index) => ({
        command: `npm test -- test-${index}.test.ts`,
        exitCode: index === 0 ? 1 : 0,
        passed: index !== 0
      })),
      errorCode: "verification_failed",
      reportPaths: { markdown: "E:/project/.codex-mimo/reports/plan-1.md" }
    }), { output });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      COMPACT_RESULT_MAX_BYTES
    );
    expect(result.failure?.code).toBe("verification_failed");
    expect(result.reportPath).toContain("plan-1.md");
  }
});

it("preserves the report path and resume instruction while reducing an attention result", () => {
  const result = renderCompactJobResult(job({
    status: "needs_input",
    phase: undefined,
    changedFiles: Array.from(
      { length: 200 },
      (_, index) => `src/${"nested/".repeat(40)}file-${index}.ts`
    ),
    reportPaths: { markdown: "report.md" }
  }));
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
    COMPACT_RESULT_MAX_BYTES
  );
  expect(result.reportPath).toBe("report.md");
  expect(result.attention?.resume).toEqual({
    tool: "mimo_resume",
    jobId: "implement-1"
  });
});

it("adds bounded operator identity, timing, phase, and first failed command at standard level", () => {
  const standard = renderJobResult(job({
    status: "failed",
    errorCode: "verification_failed",
    verification: [{ command: "npm test", exitCode: 1, passed: false }]
  }), { output: "COMPLETE OUTPUT MUST NOT APPEAR" });
  expect(standard).toMatchObject({
    jobId: "implement-1",
    phase: "verifying",
    elapsedMs: expect.any(Number),
    keyError: "npm test"
  });
  expect(standard).not.toHaveProperty("output");
});

it("returns complete diagnostic artifacts only from the full renderer", () => {
  const completed = job({ status: "completed", phase: undefined });
  const full = renderFullJobResult(completed, {
    output: "# Plan\n\nBody",
    plan: "# Plan\n\nBody",
    verificationDetails: [{
      command: "npm test",
      exitCode: 0,
      passed: true,
      stdout: "ok",
      stderr: ""
    }],
    jobLog: "safe log",
    diff: "diff --git a/a b/a",
    artifactErrors: [{
      code: "artifact_too_large",
      artifact: "diff",
      path: "large.diff",
      bytes: 1_000_001
    }]
  });
  expect(full.output).toBe("# Plan\n\nBody");
  expect(full.plan).toBe("# Plan\n\nBody");
  expect(full.verificationDetails?.[0].stdout).toBe("ok");
  expect(full.jobLog).toBe("safe log");
  expect(full.diff).toContain("diff --git");
  expect(full.artifactErrors).toEqual([{
    code: "artifact_too_large",
    artifact: "diff",
    path: "large.diff",
    bytes: 1_000_001
  }]);
});
```

Update `test/unit/core/job-render.test.ts` imports and calls so every existing idle/process observation case continues to call `renderJobStatus()`, proving the standard renderer retains those fields.
In `test/unit/job-render.test.ts`, wrap existing notification arguments as
`{ notification: value }`. Replace the old three-argument output test with the explicit
`renderFullJobResult()` case above; `renderJobResult()` must now assert that it omits `output`.

- [ ] **Step 2: Run renderer tests and verify failure**

Run:

```powershell
npm.cmd test -- job-render.test.ts test/unit/core/job-render.test.ts
```

Expected: FAIL because compact/full renderers and the byte budget do not exist.

- [ ] **Step 3: Add compact status and result rendering**

In `src/core/job-render.ts`, keep the existing standard status helpers and add:

```ts
import path from "node:path";
import {
  redactDiagnosticText,
  summarizeJobOutput
} from "./job-output.js";
import type {
  CompactJobResult,
  CompactJobStatus,
  FullJobResult,
  JobNotificationStatus,
  JobRecord,
  JobResult,
  JobStatusResult,
  JobVerification,
  StandardJobResult
} from "./jobs.js";

export const COMPACT_RESULT_MAX_BYTES = 6_000;
const MAX_COMPACT_COMMAND_CHARS = 240;
const MAX_COMPACT_PATH_CHARS = 500;
const MAX_COMPACT_FILES = 40;
const MAX_COMPACT_TESTS = 12;

export function renderCompactJobStatus(job: JobRecord): CompactJobStatus {
  const resultAvailable = job.status !== "queued" && job.status !== "running";
  return {
    status: job.status,
    ...(resultAvailable ? { resultAvailable: true as const } : {})
  };
}

export interface RenderCompactJobResultOptions {
  output?: string;
}

export function renderCompactJobResult(
  job: JobRecord,
  options: RenderCompactJobResultOptions = {}
): CompactJobResult {
  const publicSummary = publicProgressSummary({
    type: "job",
    status: job.status,
    phase: job.phase,
    ...(job.errorCode ? { errorCode: job.errorCode } : {})
  });
  const failedVerification = job.verification.find((result) => !result.passed);
  const failure = job.status === "failed" || job.status === "cancelled" || job.status === "timeout"
    ? {
        code: job.errorCode ?? job.status,
        reason: publicSummary,
        ...(failedVerification
          ? {
              failedStage: "test" as const,
              failedCommand: compactLine(redactDiagnosticText(failedVerification.command))
            }
          : {})
      }
    : null;
  const semantic = isSemanticResultJob(job)
    ? summarizeJobOutput(options.output)
    : undefined;
  const attention = job.status === "needs_input" || job.status === "blocked"
    ? {
        kind: job.status,
        reason: publicSummary,
        resume: { tool: "mimo_resume" as const, jobId: job.id }
      }
    : undefined;
  const result: CompactJobResult = {
    status: job.status,
    changedFiles: job.changedFiles.map(compactFilePath),
    tests: job.verification.map((verification) => ({
      stage: "test",
      command: compactLine(redactDiagnosticText(verification.command)),
      outcome: verification.passed ? "passed" : "failed"
    })),
    failure,
    reportPath: compactReportPath(job, semantic
      ? (job.reportPaths?.plan ?? job.reportPaths?.result ?? job.reportPaths?.markdown)
      : (job.reportPaths?.markdown ?? job.reportPaths?.result)),
    ...(semantic ? { summary: semantic } : {}),
    ...(attention ? { attention } : {})
  };
  return fitCompactResult(result);
}

export function isSemanticResultJob(job: JobRecord): boolean {
  if (job.kind === "plan" || job.kind === "review") return true;
  if (job.kind !== "compose" || typeof job.request !== "object" || job.request === null) {
    return false;
  }
  const workflow = (job.request as Record<string, unknown>).workflow;
  return workflow === "brainstorm" || workflow === "plan" || workflow === "review";
}

function compactLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_COMPACT_COMMAND_CHARS);
}

function compactFilePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.length <= MAX_COMPACT_PATH_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_COMPACT_PATH_CHARS - 1)}…`;
}

function compactReportPath(job: JobRecord, value: string | undefined): string | null {
  if (!value) return null;
  if (!path.isAbsolute(value)) return value.split(path.sep).join("/");
  const relative = path.relative(job.cwd, value);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : value;
}
```

- [ ] **Step 4: Add deterministic budget reduction**

Add to `src/core/job-render.ts`:

```ts
function fitCompactResult(input: CompactJobResult): CompactJobResult {
  const result: CompactJobResult = {
    ...input,
    changedFiles: [...input.changedFiles],
    tests: [...input.tests],
    ...(input.failure ? { failure: { ...input.failure } } : {})
  };
  if (compactBytes(result) <= COMPACT_RESULT_MAX_BYTES) return result;

  delete result.summary;
  result.tests = result.tests.slice(0, MAX_COMPACT_TESTS);
  result.changedFiles = compactFiles(result.changedFiles, MAX_COMPACT_FILES);
  if (compactBytes(result) <= COMPACT_RESULT_MAX_BYTES) return result;

  result.tests = firstResultPerStage(result.tests);
  result.changedFiles = compactFiles(input.changedFiles, 10);
  if (result.failure?.failedTests) result.failure.failedTests = result.failure.failedTests.slice(0, 3);
  if (compactBytes(result) <= COMPACT_RESULT_MAX_BYTES) return result;

  result.changedFiles = compactFiles(input.changedFiles, 1);
  result.tests = result.tests.slice(0, 1);
  if (result.failure) {
    result.failure.reason = result.failure.reason.slice(0, 240);
    if (result.failure.suggestion) {
      result.failure.suggestion = result.failure.suggestion.slice(0, 240);
    }
  }
  if (compactBytes(result) > COMPACT_RESULT_MAX_BYTES) {
    throw new Error("Compact job result exceeds the 6000-byte public contract.");
  }
  return result;
}

function compactFiles(files: string[], limit: number): string[] {
  if (files.length <= limit) return files;
  return [
    ...files.slice(0, limit),
    `<${files.length - limit} more; see report>`
  ];
}

function firstResultPerStage(
  tests: CompactJobResult["tests"]
): CompactJobResult["tests"] {
  const seen = new Set<string>();
  return tests.filter((test) => {
    if (seen.has(test.stage)) return false;
    seen.add(test.stage);
    return true;
  });
}

function compactBytes(result: CompactJobResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}
```

- [ ] **Step 5: Make the existing result renderer the standard view**

Change `renderJobResult()` to return `StandardJobResult`, accept an options object, and merge the compact projection:

```ts
export interface RenderJobResultOptions {
  notification?: JobNotificationStatus;
  output?: string;
  keyError?: string;
}

export function renderJobResult(
  job: JobRecord,
  options: RenderJobResultOptions = {}
): StandardJobResult {
  const partial = job.status === "needs_input" || job.status === "blocked";
  const compact = renderCompactJobResult(job, { output: options.output });
  const keyError = options.keyError ?? compact.failure?.failedCommand;
  return {
    ...compact,
    jobId: job.id,
    kind: job.kind,
    parentJobId: job.parentJobId ?? null,
    resultType: partial ? "partial" : "final",
    summary: compact.summary ?? publicProgressSummary({
      type: "job",
      status: job.status,
      phase: job.phase,
      ...(job.errorCode ? { errorCode: job.errorCode } : {})
    }),
    ...(job.phase ? { phase: job.phase } : {}),
    elapsedMs: elapsedMs(job),
    sessionId: job.sessionId ?? null,
    ...(keyError ? { keyError } : {}),
    verification: job.verification.map(compactVerification),
    ...(job.executionCallback ? { executionCallback: publicExecutionCallback(job) } : {}),
    ...(job.error
      ? {
          error: publicProgressSummary({
            type: "job",
            status: job.status,
            ...(job.errorCode ? { errorCode: job.errorCode } : {})
          })
        }
      : {}),
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    ...(job.reportPaths ? { reportPaths: { ...job.reportPaths } } : {}),
    ...(options.notification
      ? { notification: publicNotification(options.notification) }
      : {}),
    actions: {
      status: "mimo_status",
      events: "mimo_events",
      ...(partial ? { resume: "mimo_resume" as const } : {})
    }
  };
}
```

Remove `output` from this standard renderer.
Also replace the retained verification projection with a bounded, redacted command:

```ts
function compactVerification(result: JobVerification): JobVerification {
  return {
    command: compactLine(redactDiagnosticText(result.command)),
    exitCode: result.exitCode,
    passed: result.passed,
    ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs })
  };
}
```

- [ ] **Step 6: Add the explicit full renderer**

Add:

```ts
export interface RenderFullJobResultOptions extends RenderJobResultOptions {
  plan?: string;
  verificationDetails?: FullJobResult["verificationDetails"];
  jobLog?: string;
  diff?: string;
  artifactErrors?: FullJobResult["artifactErrors"];
}

export function renderFullJobResult(
  job: JobRecord,
  options: RenderFullJobResultOptions = {}
): JobResult {
  return {
    ...renderJobResult(job, options),
    ...(options.output?.trim() ? { output: options.output } : {}),
    ...(options.plan?.trim() ? { plan: options.plan } : {}),
    ...(options.verificationDetails
      ? { verificationDetails: options.verificationDetails.map((result) => ({ ...result })) }
      : {}),
    ...(options.jobLog?.trim() ? { jobLog: options.jobLog } : {}),
    ...(options.diff?.trim() ? { diff: options.diff } : {}),
    ...(options.artifactErrors
      ? { artifactErrors: options.artifactErrors.map((error) => ({ ...error })) }
      : {})
  };
}
```

- [ ] **Step 7: Replace the legacy result interface and migrate call sites without changing public behavior**

After the renderers compile, replace the old `JobResult` interface in `src/core/jobs.ts` with:

```ts
/** Compatibility name for callers that explicitly request the full result. */
export type JobResult = FullJobResult;
```

In `src/codex/tools.ts`, keep the pre-Task-5 output-rich `mimo_result` behavior temporarily:

```ts
return renderFullJobResult(job, {
  notification: notificationStatus(job),
  output: readFinalJobOutput(job.eventsFile)
});
```

Change cancellation call sites from:

```ts
renderJobResult(job, notificationStatus(job))
```

to:

```ts
renderJobResult(job, { notification: notificationStatus(job) })
```

In `src/notify/codex-adapter.ts`, retain V1 until Task 6 tests are ready:

```ts
const rendered = renderFullJobResult(job, {
  output: readFinalJobOutput(job.eventsFile)
});
```

This mechanical migration keeps the repository type-correct and preserves the old callback/result
behavior until their dedicated review gates.

- [ ] **Step 8: Run renderer tests and lint**

Run:

```powershell
npm.cmd test -- job-render.test.ts test/unit/core/job-render.test.ts
npm.cmd run lint
```

Expected: PASS. Standard observability remains available; only explicit full includes output.

- [ ] **Step 9: Conditional commit checkpoint**

Only if explicitly authorized:

```powershell
git add src/core/jobs.ts src/core/job-render.ts src/codex/tools.ts src/notify/codex-adapter.ts test/unit/job-render.test.ts test/unit/core/job-render.test.ts
git commit -m "feat(results): add compact and full render levels"
```

### Task 5: Wire MCP and CLI output levels

**Files:**
- Modify: `src/codex/tools.ts:28-31,150-160,249-263`
- Modify: `src/cli/commands.ts:67-71,187-207`
- Modify: `src/codex/mcp-server.ts:100-115`
- Modify: `test/unit/mcp-tools/mimo-result.test.ts:20-126`
- Modify: `test/unit/mcp-tools/mimo-status.test.ts:20-192`
- Modify: `test/unit/cli.test.ts:160-192`
- Modify: `test/unit/mcp-work-schema-registration.test.ts:63-72`

**Interfaces:**
- `mimo_status` default: `CompactJobStatus`.
- `mimo_result` default: `CompactJobResult`.
- `level: "standard"`: existing sanitized operator structures without full contents.
- `level: "full"`: standard structures plus diagnostics read from artifacts.
- CLI `status` without `--level`: sends `"standard"`; CLI `result` without `--level`: sends `"compact"`.

- [ ] **Step 1: Write failing MCP tool tests**

Update `test/unit/mcp-tools/mimo-status.test.ts`:

```ts
it("returns only the heartbeat state by default", async () => {
  const cwd = tempWorkspace();
  const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
  updateJob(cwd, job.id, {
    status: "running",
    phase: "investigating",
    pid: 100,
    processIdentity: "start-100"
  });

  const verifyProcess = vi.fn();
  expect(await mimoStatus(
    { cwd, jobId: job.id },
    { verifyProcess }
  )).toEqual({ status: "running" });
  expect(verifyProcess).not.toHaveBeenCalled();
});

it("returns live diagnostics only at standard level", async () => {
  const cwd = tempWorkspace();
  const job = createJobStore(cwd).create({ kind: "compose", task: "Run dev", request: {} });
  updateJob(cwd, job.id, {
    status: "running",
    phase: "investigating",
    pid: 100,
    processIdentity: "start-100"
  });
  const result = await mimoStatus({ cwd, jobId: job.id, level: "standard" }, {
    verifyProcess: () => ({ status: "match" as const, evidence: "matched" })
  });
  expect(result).toMatchObject({
    jobId: job.id,
    status: "running",
    phase: "investigating",
    processAlive: true
  });
});
```

Update every existing process/notification assertion in that file to pass `level: "standard"`.
Because `mimoStatus()` has a named union return type, narrow before reading standard-only fields:

```ts
function requireStandardStatus(
  result: Awaited<ReturnType<typeof mimoStatus>>
): asserts result is JobStatusResult {
  if (!("jobId" in result)) throw new Error("Expected a standard job status.");
}
```

Call `requireStandardStatus(result)` before reading `phase`, `processAlive`, `lastEventAt`,
`lastTool`, `idleMs`, `idleTimeoutMs`, `executionCallback`, or `notification`.

Update `test/unit/mcp-tools/mimo-result.test.ts` and import
`FULL_ARTIFACT_MAX_BYTES` from `src/core/job-output.js`:

```ts
it("omits final output by default and exposes it only at full level", async () => {
  const cwd = tempWorkspace();
  const job = createJobStore(cwd).create({ kind: "plan", task: "Plan", request: {} });
  const output = "# Plan\n\nComplete carousel implementation.";
  fs.writeFileSync(
    job.eventsFile,
    `${JSON.stringify({ type: "text", part: { text: output } })}\n`,
    "utf8"
  );
  updateJob(cwd, job.id, {
    status: "completed",
    summary: "Done.",
    reportPaths: {
      markdown: path.join(cwd, ".codex-mimo", "reports", `${job.id}.md`),
      plan: path.join(cwd, ".codex-mimo", "reports", `${job.id}.plan.md`)
    }
  });

  const compact = await mimoResult({ cwd, jobId: job.id });
  expect(compact).toMatchObject({
    status: "completed",
    summary: "Complete carousel implementation.",
    reportPath: expect.stringContaining(`${job.id}.plan.md`)
  });
  expect(compact).not.toHaveProperty("output");

  const full = await mimoResult({ cwd, jobId: job.id, level: "full" });
  expect(full).toMatchObject({ output });
});

it("returns an exact artifact_too_large reference from full level", async () => {
  const cwd = tempWorkspace();
  const job = createJobStore(cwd).create({ kind: "plan", task: "Plan", request: {} });
  const resultFile = path.join(cwd, "oversized.result.md");
  fs.writeFileSync(resultFile, "x".repeat(FULL_ARTIFACT_MAX_BYTES + 1), "utf8");
  updateJob(cwd, job.id, {
    status: "completed",
    reportPaths: { result: resultFile }
  });

  const full = await mimoResult({ cwd, jobId: job.id, level: "full" });
  expect(full).toMatchObject({
    artifactErrors: [{
      code: "artifact_too_large",
      artifact: "output",
      path: resultFile,
      bytes: FULL_ARTIFACT_MAX_BYTES + 1
    }]
  });
  expect(full).not.toHaveProperty("output");
});

it("returns one bounded verification excerpt at standard level", async () => {
  const cwd = tempWorkspace();
  const job = createJobStore(cwd).create({ kind: "compose", task: "Test", request: {} });
  const verificationFile = path.join(cwd, "verification.json");
  fs.writeFileSync(verificationFile, JSON.stringify([{
    command: "npm test",
    exitCode: 1,
    passed: false,
    stdout: "",
    stderr: "token=private assertion failed"
  }]), "utf8");
  updateJob(cwd, job.id, {
    status: "failed",
    errorCode: "verification_failed",
    verification: [{ command: "npm test", exitCode: 1, passed: false }],
    reportPaths: { verification: verificationFile }
  });

  const standard = await mimoResult({ cwd, jobId: job.id, level: "standard" });
  expect(standard).toMatchObject({
    keyError: "token=[REDACTED] assertion failed"
  });
  expect(standard).not.toHaveProperty("output");
});
```

Change notification metadata tests to request `level: "standard"` because compact intentionally omits notification details.
Narrow those assertions before accessing `notification`:

```ts
function requireStandardResult(
  result: Awaited<ReturnType<typeof mimoResult>>
): asserts result is StandardJobResult {
  if (!("jobId" in result)) throw new Error("Expected a standard job result.");
}
```

Update the remaining existing `mimo_result` cases as follows:

```ts
// Compact default has no identity/resultType fields.
const compact = await mimoResult({ cwd, jobId: job.id });
expect(compact.status).toBe(status);
expect(compact).not.toHaveProperty("jobId");
expect(compact).not.toHaveProperty("resultType");

// Standard preserves the prior identity and partial/final classification.
const standard = await mimoResult({ cwd, jobId: job.id, level: "standard" });
requireStandardResult(standard);
expect(standard.resultType).toBe(
  status === "needs_input" || status === "blocked" ? "partial" : "final"
);
```

For the omitted-`jobId` selection test, give the selected terminal record a unique
`reportPaths.markdown` and assert the compact `reportPath`; do not assert `jobId`. For the legacy
missing-events test, assert `{ status: "completed", reportPath: null }` and absence of `output`.

In `test/unit/mcp-tools/mimo-status.test.ts`, request `level: "standard"` in the existing
most-recent-job test before asserting `jobId`. Compact status intentionally has no identity field.

- [ ] **Step 2: Write failing CLI level tests**

Add to `test/unit/cli.test.ts`:

```ts
it("uses standard CLI status and compact CLI result defaults", async () => {
  const status = await invoke(["status", "--job-id", jobId]);
  const result = await invoke(["result", "--job-id", jobId]);

  expect(status.deps.mimoStatus).toHaveBeenCalledWith({
    cwd,
    jobId,
    level: "standard"
  });
  expect(result.deps.mimoResult).toHaveBeenCalledWith({
    cwd,
    jobId,
    level: "compact"
  });
});

it("forwards an explicit output level and rejects unknown levels", async () => {
  const full = await invoke(["result", "--job-id", jobId, "--level", "full"]);
  expect(full.deps.mimoResult).toHaveBeenCalledWith({
    cwd,
    jobId,
    level: "full"
  });

  const invalid = await invoke(["result", "--job-id", jobId, "--level", "verbose"]);
  expect(invalid.exitCode).toBe(2);
  expect(invalid.stderr).toContain("--level must be compact, standard, or full");
});
```

- [ ] **Step 3: Run focused MCP/CLI tests and verify failure**

Run:

```powershell
npm.cmd test -- mimo-result.test.ts mimo-status.test.ts cli.test.ts mcp-work-schema-registration.test.ts
```

Expected: FAIL because handlers ignore `level` and CLI rejects `--level`.

- [ ] **Step 4: Select status rendering without loading diagnostics for compact**

In `src/codex/tools.ts`, import the new types/renderers, including
`isSemanticResultJob`, and change `mimoStatus()`:

```ts
export async function mimoStatus(
  input: unknown,
  deps: MimoStatusDependencies = {}
): Promise<RenderedJobStatus> {
  const parsed = JobStatusInput.parse(input);
  const job = parsed.jobId ? readJob(parsed.cwd, parsed.jobId) : listJobs(parsed.cwd)[0];
  if (!job) throw new Error("No jobs recorded for this workspace.");
  if (parsed.level === "compact") return renderCompactJobStatus(job);

  const processAlive = probeProcessAlive(job, deps);
  return renderJobStatus(job, {
    progress: readRecentJobLogLines(job.logFile, 5),
    notification: notificationStatus(job),
    ...(processAlive !== undefined ? { processAlive } : {})
  });
}
```

In Phase 1, `full` status intentionally equals the standard status view; raw JSONL is never inlined by status.

- [ ] **Step 5: Select result rendering and artifact reads by level**

Import `readFinalJobOutput`, `readSavedJobOutput`, `readKeyVerificationError`, and
`readJobDiagnostics`, then change `mimoResult()`:

```ts
export async function mimoResult(input: unknown): Promise<RenderedJobResult> {
  const parsed = JobResultInput.parse(input);
  const job = parsed.jobId
    ? readJob(parsed.cwd, parsed.jobId)
    : listJobs(parsed.cwd).find((candidate) => isResultStatus(candidate.status));
  if (!job) {
    throw new Error(parsed.jobId
      ? `No job found for ${parsed.jobId}.`
      : "No job results recorded for this workspace.");
  }
  if (!isResultStatus(job.status)) {
    throw new Error(`Job result is not available while ${job.id} is ${job.status}.`);
  }

  if (parsed.level === "full") {
    const fallbackOutput = job.reportPaths?.result
      ? undefined
      : readFinalJobOutput(job.eventsFile);
    return renderFullJobResult(job, {
      notification: notificationStatus(job),
      ...readJobDiagnostics(job, fallbackOutput)
    });
  }

  const output = isSemanticResultJob(job) ? readSavedJobOutput(job) : undefined;
  if (parsed.level === "compact") {
    return renderCompactJobResult(job, { output });
  }
  return renderJobResult(job, {
    notification: notificationStatus(job),
    output,
    keyError: readKeyVerificationError(job.reportPaths?.verification)
  });
}
```

Update cancellation and job-list call sites to continue using `renderJobResult(job, { notification })` and standard `renderJobStatus()`.

- [ ] **Step 6: Add CLI level parsing**

In `src/cli/commands.ts`, add `"--level"` to `VALUE_FLAGS`, import `JobOutputLevel`, and add:

```ts
function takeOutputLevel(
  parsed: ParsedArguments,
  fallback: JobOutputLevel
): JobOutputLevel {
  const value = parsed.takeValue("--level") ?? fallback;
  if (value !== "compact" && value !== "standard" && value !== "full") {
    throw new CliInputError("--level must be compact, standard, or full.");
  }
  return value;
}
```

Change the status/result branches:

```ts
if (command === "status") {
  const level = takeOutputLevel(parsed, "standard");
  parsed.assertConsumed();
  return (dependencies.mimoStatus ?? defaultMimoStatus)({
    cwd,
    ...(jobId ? { jobId } : {}),
    level
  });
}
if (command === "result") {
  const level = takeOutputLevel(parsed, "compact");
  parsed.assertConsumed();
  return (dependencies.mimoResult ?? defaultMimoResult)({
    cwd,
    ...(jobId ? { jobId } : {}),
    level
  });
}
```

- [ ] **Step 7: Update MCP descriptions and registration contract**

Change `src/codex/mcp-server.ts` descriptions:

```ts
server.registerTool("mimo_compose", {
  description: "Run a Compose workflow in a background job. Plan workflows are read-only; compact results return a summary and saved plan path. verification holds executable no-shell commands.",
  inputSchema: ComposeInput
}, handle("mimo_compose", handlers.mimoCompose));

server.registerTool("mimo_status", {
  description: "Return a minimal heartbeat status by default; request standard or full for diagnostics",
  inputSchema: JobStatusInput
}, handle("mimo_status", handlers.mimoStatus));

server.registerTool("mimo_result", {
  description: "Return a compact job result by default; request standard or full only for diagnostics",
  inputSchema: JobResultInput
}, handle("mimo_result", handlers.mimoResult));
```

Update `test/unit/mcp-work-schema-registration.test.ts` to require “summary” and “saved plan path” in the Compose description and “compact”/“full” in the result description.

- [ ] **Step 8: Run focused tests and build**

Run:

```powershell
npm.cmd test -- mimo-result.test.ts mimo-status.test.ts cli.test.ts mcp-work-schema-registration.test.ts
npm.cmd run build
```

Expected: PASS. Default MCP status/result are compact; explicit standard/full paths work.

- [ ] **Step 9: Conditional commit checkpoint**

Only if explicitly authorized:

```powershell
git add src/codex/tools.ts src/cli/commands.ts src/codex/mcp-server.ts test/unit/mcp-tools/mimo-result.test.ts test/unit/mcp-tools/mimo-status.test.ts test/unit/cli.test.ts test/unit/mcp-work-schema-registration.test.ts
git commit -m "feat(results): wire compact MCP defaults"
```

### Task 6: Make the prefetched Codex callback compact-only

**Files:**
- Modify: `src/notify/codex-adapter.ts:1-39`
- Modify: `src/notify/webhook-adapter.ts:1-66`
- Modify: `test/unit/notify/codex-adapter.test.ts:69-159`
- Modify: `test/unit/notify/webhook-adapter.test.ts`
- Modify: `test/unit/cross-cutting/public-summary.test.ts:23-121`
- Modify: `test/integration/unified-background-jobs.test.ts:283-321`
- Modify: `test/smoke/local-codex-notification.test.ts:18-21,95-128,189-197`

**Interfaces:**
- Produces: `CodexCallbackResult = CompactJobResult`.
- Produces: `MIMO_CALLBACK_RESULT_V2`.
- Consumes: final text locally only to derive a bounded plan/review summary; never serializes `output`.
- Preserves: webhook version 1 shape while redacting and bounding persisted verification commands.

- [ ] **Step 1: Write failing callback tests**

Replace the output-rich assertions in `test/unit/notify/codex-adapter.test.ts`:

```ts
it("attaches one compact result and never embeds final output", () => {
  const prepared = jobWithEvents("CODEX_MIMO_NOTIFY_SMOKE_OUTPUT_v1", {
    reportPaths: { markdown: "report.md", result: "result.md" }
  });
  const prompt = buildCodexNotificationPrompt(delivery, prepared, signal);

  expect(prompt.startsWith("MIMO_CALLBACK_RESULT_V2\n")).toBe(true);
  expect(prompt).toContain("<mimo_callback_result>");
  expect(prompt).toContain('"status":"completed"');
  expect(prompt).toContain('"reportPath":"report.md"');
  expect(prompt).not.toContain("CODEX_MIMO_NOTIFY_SMOKE_OUTPUT_v1");
  expect(prompt).not.toContain('"output"');
  expect(prompt).not.toContain('"notification"');
  expect(prompt).not.toContain('"actions"');
});

it("prefetches a bounded plan summary and artifact path", () => {
  const prepared = jobWithEvents("# Plan\n\nImplement three focused steps.", {
    kind: "plan",
    reportPaths: { markdown: "report.md", plan: "plan.md" }
  });
  expect(buildCodexCallbackResult(prepared)).toEqual({
    status: "completed",
    changedFiles: [],
    tests: [],
    failure: null,
    reportPath: "plan.md",
    summary: "Implement three focused steps."
  });
});

it("creates a compact attention callback without identity or generic actions", () => {
  const result = buildCodexCallbackResult({
    ...job,
    status: "needs_input",
    reportPaths: { markdown: "report.md" }
  });
  expect(result).toMatchObject({
    status: "needs_input",
    attention: {
      kind: "needs_input",
      resume: { tool: "mimo_resume", jobId: "implement-1" }
    }
  });
  expect(result).not.toHaveProperty("jobId");
  expect(result).not.toHaveProperty("resultType");
  expect(result).not.toHaveProperty("actions");
  expect(result).not.toHaveProperty("notification");
});
```

Update the one-turn test to assert V2 and absence of the smoke output marker.
Delete the old assertion that a partial callback carries `jobId` and `resultType`; the attention
test above replaces it.

- [ ] **Step 2: Update the public-boundary test**

In `test/unit/cross-cutting/public-summary.test.ts`, replace the default-output assertions:

```ts
const compact = await mimoResult({ cwd, jobId: job.id });
expect(JSON.stringify(compact)).not.toContain(marker);

const full = await mimoResult({ cwd, jobId: job.id, level: "full" });
expect(full).toMatchObject({ output: marker });

const prompt = buildCodexNotificationPrompt(delivery, readJob(cwd, job.id)!, signal);
expect(prompt).toContain("MIMO_CALLBACK_RESULT_V2");
expect(prompt).not.toContain(marker);
expect(prompt).not.toContain('"output"');
```

Keep the existing structural report, audit, webhook, task, and request non-leak assertions.

- [ ] **Step 3: Run callback tests and verify failure**

Run:

```powershell
npm.cmd test -- codex-adapter.test.ts public-summary.test.ts
```

Expected: FAIL because callbacks still render the output-rich V1 result.

- [ ] **Step 4: Switch the callback projection**

Replace the callback projection in `src/notify/codex-adapter.ts`:

```ts
import { readSavedJobOutput } from "../core/job-output.js";
import {
  isSemanticResultJob,
  renderCompactJobResult
} from "../core/job-render.js";
import type { CompactJobResult, JobRecord } from "../core/jobs.js";

export type CodexCallbackResult = CompactJobResult;

export function buildCodexCallbackResult(job: JobRecord): CodexCallbackResult {
  return renderCompactJobResult(job, {
    ...(isSemanticResultJob(job)
      ? { output: readSavedJobOutput(job) }
      : {})
  });
}
```

Change only the prompt marker:

```ts
"MIMO_CALLBACK_RESULT_V2",
```

Retain the event ID, tool prohibition, untrusted-data delimiter, one-turn behavior, and retry policy.

- [ ] **Step 5: Redact webhook verification commands without changing its envelope**

Add to `test/unit/notify/webhook-adapter.test.ts`:

```ts
it("redacts and bounds verification commands", () => {
  const payload = buildNotificationPayload(delivery, {
    ...job,
    verification: [{
      command: `npm test --token private ${"x".repeat(300)}`,
      exitCode: 1,
      passed: false
    }]
  }, signal);

expect(payload.result.verification).toEqual([{
    command: expect.stringMatching(/^npm test --token \[REDACTED\]/),
  exitCode: 1,
  passed: false
}]);
expect(JSON.stringify(payload)).not.toContain("private");
  expect(payload.result.verification[0].command.length).toBeLessThanOrEqual(240);
});
```

In `src/notify/webhook-adapter.ts`, import `redactDiagnosticText` and replace the verification
projection with:

```ts
verification: job.verification.map((verification) => ({
  ...verification,
  command: redactDiagnosticText(verification.command).slice(0, 240)
})),
```

- [ ] **Step 6: Update the unified integration test**

Replace the Compose plan case in `test/integration/unified-background-jobs.test.ts` with assertions that:

```ts
const compact = await mimoResult({ cwd, jobId: completed.id });
const compactPlanPath = path.relative(cwd, completed.reportPaths!.plan!)
  .split(path.sep)
  .join("/");
expect(compact).toMatchObject({
  status: "completed",
  summary: "Task 1...",
  reportPath: compactPlanPath
});
expect(compact).not.toHaveProperty("output");
expect(fs.readFileSync(completed.reportPaths!.plan!, "utf8")).toBe(planMarkdown);

const full = await mimoResult({ cwd, jobId: completed.id, level: "full" });
expect(full).toMatchObject({ output: planMarkdown, plan: planMarkdown });

const callbackText = params.input[0].text;
expect(callbackText).toContain("MIMO_CALLBACK_RESULT_V2");
expect(callbackText).toContain('"summary":"Task 1..."');
expect(callbackText).toContain(
  '"reportPath":' + JSON.stringify(compactPlanPath)
);
expect(callbackText).not.toContain(planMarkdown);
expect(callbackText).not.toContain('"output"');
```

Keep the structural Compose report assertions: `.json` and `.md` do not contain the plan body.

Update the other callback integration case near the frozen-target assertions:

```ts
expect(params.input[0].text).toContain("MIMO_CALLBACK_RESULT_V2");
expect(params.input[0].text).toContain('"status":"completed"');
expect(params.input[0].text).toContain('"reportPath":');
expect(params.input[0].text).not.toContain('"jobId"');
expect(params.input[0].text).not.toContain('"output"');
expect(params.input[0].text).not.toContain("Job completed from fake MiMo.");
```

For the `result_missing` integration case, replace top-level `errorCode` assertions on the default
result with:

```ts
expect(result).toMatchObject({
  status: "failed",
  failure: { code: "result_missing" }
});
expect(result).not.toHaveProperty("output");
```

- [ ] **Step 7: Update the gated real-Codex smoke contract**

Keep `OUTPUT_MARKER` as proof that MiMo's complete final text reached the saved result artifact.
Replace the callback-response marker assertion with:

```ts
const callbackResponse = await waitForTargetAssistantResponse(
  threadId,
  330_000,
  smokeStartedAt
);
expect(callbackResponse.trim()).not.toBe("");
expect(callbackResponse).not.toContain(OUTPUT_MARKER);

const finalJob = readJob(workspace, receipt.jobId)!;
expect(finalJob.reportPaths?.result).toBeDefined();
expect(fs.readFileSync(finalJob.reportPaths!.result!, "utf8")).toContain(OUTPUT_MARKER);
```

The smoke still proves one App Server history-writeback turn and now separately proves that complete
MiMo output is durable without entering the compact callback context.

- [ ] **Step 8: Run callback and integration tests**

Run:

```powershell
npm.cmd test -- codex-adapter.test.ts webhook-adapter.test.ts public-summary.test.ts unified-background-jobs.test.ts
npm.cmd test -- local-codex-notification.test.ts
```

Expected: PASS; the local Codex smoke is skipped unless its existing environment gate is enabled.
Automatic callback context contains only compact delivery data.

- [ ] **Step 9: Conditional commit checkpoint**

Only if explicitly authorized:

```powershell
git add src/notify/codex-adapter.ts src/notify/webhook-adapter.ts test/unit/notify/codex-adapter.test.ts test/unit/notify/webhook-adapter.test.ts test/unit/cross-cutting/public-summary.test.ts test/integration/unified-background-jobs.test.ts test/smoke/local-codex-notification.test.ts
git commit -m "feat(notify): prefetch compact job results"
```

### Task 7: Publish the compact-default contract and run release verification

**Files:**
- Modify carefully: `skills/mimocode/SKILL.md`
- Modify carefully: `README.md`
- Modify carefully: `doc/operations-guide.md`
- Modify: `doc/compose-workflows.md`
- Modify: `test/unit/public-release-contract.test.ts:94-151`
- Modify carefully: `test/unit/packaged-skill.test.ts:1-38`
- Verify only unless wording requires a surgical merge: `.codex-plugin/plugin.json`

**Interfaces:**
- Documents: compact default, standard diagnostics, full manual troubleshooting, saved plan/result artifacts, 6,000-byte budget, and callback V2.
- Removes: instructions to consume `mimo_result.output` by default.
- Preserves: Desktop heartbeat, companion zero-poll, compatibility App Server semantics, explicit notification preflight, and result-missing behavior.

- [ ] **Step 1: Rewrite the failing release-contract assertions first**

Replace the old `mimo_result.output` contract tests in `test/unit/public-release-contract.test.ts` with:

```ts
it("documents compact default results and explicit full diagnostics", () => {
  for (const file of ALL_DOCS) {
    const contents = readDoc(file);
    expect(contents).toMatch(/mimo_result[\s\S]{0,120}(?:compact|default)/i);
    expect(contents).toMatch(/(?:level|output level)[\s\S]{0,120}full/i);
    expect(contents).toMatch(/report path|saved plan|plan artifact/i);
    expect(contents).not.toMatch(/answer from `?mimo_result\.output`? when present/i);
  }
});

it("documents structural reports plus separate semantic artifacts", () => {
  for (const file of USER_DOCS) {
    const contents = readDoc(file);
    expect(contents).toMatch(/structural/i);
    expect(contents).toMatch(/\.result\.md/);
    expect(contents).toMatch(/\.plan\.md/);
    expect(contents).toMatch(/\.verification\.json/);
    expect(contents).toMatch(/(?:do not|omit)[\s\S]{0,100}(?:inline|model output|stdout|stderr)/i);
  }
  for (const file of ["README.md", "doc/operations-guide.md"]) {
    expect(readDoc(file)).toMatch(/artifact_too_large/);
  }
});

it("documents compact heartbeat consumption in the skill", () => {
  const skill = readDoc(SKILL);
  expect(skill).toMatch(/heartbeat[\s\S]{0,220}mimo_status[\s\S]{0,120}compact/i);
  expect(skill).toMatch(/mimo_result[\s\S]{0,120}reportPath|report path/i);
  expect(skill).toMatch(/manual|diagnos|troubleshoot[\s\S]{0,160}full/i);
});
```

This replaces the existing assertion that treats every `reports/*.md` file as structural. The new
contract distinguishes structural `<jobId>.json`/`<jobId>.md` from semantic
`<jobId>.result.md`/`<jobId>.plan.md`; only the structural pair must omit model output.

Extend `test/unit/packaged-skill.test.ts`:

```ts
it("teaches compact result consumption and explicit full diagnostics", () => {
  expect(skill).toMatch(/mimo_status[\s\S]{0,100}compact/i);
  expect(skill).toMatch(/mimo_result[\s\S]{0,120}compact/i);
  expect(skill).toMatch(/reportPath|report path|saved plan/i);
  expect(skill).toMatch(/(?:level|output level)[\s\S]{0,100}full/i);
  expect(skill).not.toMatch(/answer from `?mimo_result\.output`? when present/i);
});
```

- [ ] **Step 2: Run documentation tests and verify failure**

Run:

```powershell
npm.cmd test -- public-release-contract.test.ts packaged-skill.test.ts
```

Expected: FAIL while docs still teach output-rich default consumption.

- [ ] **Step 3: Update the packaged skill with exact operational guidance**

Re-read the dirty `skills/mimocode/SKILL.md`, preserve unrelated heartbeat/preflight edits, and replace output guidance with these statements in the relevant sections:

```markdown
On each Desktop heartbeat, call `mimo_status` once with the default compact level. While it returns
`queued` or `running`, stop quietly. On attention or terminal status, call `mimo_result` once at the
default compact level, delete the heartbeat, and answer from its status, changed files, tests,
failure, bounded plan/review summary when present, and `reportPath`.

`mimo_result` output levels are `compact` (default), `standard` (bounded operator diagnostics), and
`full` (complete saved result, plan, verification evidence, safe job log, and diff). Request `full`
only for explicit manual troubleshooting; do not use it on normal heartbeat or callback paths.

Plan workflows remain read-only. MiMoCode must return the plan in its final response and must not
write a project plan file. The bridge saves that final response to
`.codex-mimo/reports/<jobId>.plan.md`; compact callers consume only the bounded summary and report
path.
```

Also replace the control-tool bullets with:

```markdown
- `mimo_status`: compact heartbeat state by default; `standard` exposes bounded live diagnostics.
- `mimo_result`: compact delivery result by default; `standard` adds key diagnostics; `full` is
  explicit manual troubleshooting.
```

- [ ] **Step 4: Update README and operations guide**

Merge these exact contract points into both dirty files:

```markdown
`mimo_result` defaults to a compact delivery record: status, changed files, compact verification
results, failure, report path, and a bounded plan/review summary when applicable. Complete final
text is not returned by default. `reportPath` is repository-relative when the artifact is inside
the requested workspace.

Use `level: "standard"` for bounded operator diagnostics and `level: "full"` only for explicit
manual troubleshooting. `full` reads complete semantic and verification artifacts; normal Desktop
heartbeat and automatic callback delivery remain compact.

Full responses inline at most 1,000,000 bytes per artifact. A larger artifact is not truncated:
the result contains `artifact_too_large`, the exact artifact path, and its byte count.

Every finalized job has structural report paths. Complete semantic output is saved separately as
`<jobId>.result.md`; plans additionally use `<jobId>.plan.md`; full verification stdout/stderr uses
`<jobId>.verification.json`. Structural `.json`/`.md` reports link to these files and do not inline
their content. Recognized credentials are redacted before semantic or verification artifacts are
persisted and before full diagnostics are returned.
```

Update CLI examples to include:

```powershell
codex-mimo status --cwd E:\project --job-id <job-id>
codex-mimo result --cwd E:\project --job-id <job-id>
codex-mimo result --cwd E:\project --job-id <job-id> --level full
```

State that CLI `status` defaults to standard for humans, while MCP `mimo_status` defaults to compact.
In the existing real-Codex smoke paragraphs, state that the smoke proves three separate facts: the
complete MiMo marker is present in `<jobId>.result.md`, the callback assistant response is non-empty
but does not echo that marker, and exactly one callback `turn/start` reaches independent session
history.

- [ ] **Step 5: Update Compose workflow documentation**

In `doc/compose-workflows.md`, replace the plan/report sections with:

```markdown
The `plan` workflow remains read-only. MiMoCode returns the plan in its final response and does not
write project files. During host finalization the bridge saves the complete plan to
`.codex-mimo/reports/<jobId>.plan.md`. Default `mimo_result` returns only a bounded summary and
`reportPath`; use `level: "full"` only for explicit troubleshooting.

Compose finalization writes structural JSON/Markdown/event reports plus applicable semantic
artifacts:

- `.codex-mimo/reports/<jobId>.result.md`
- `.codex-mimo/reports/<jobId>.plan.md` for planning workflows
- `.codex-mimo/reports/<jobId>.verification.json` when host verification ran
- `.codex-mimo/diffs/<jobId>.diff` when a diff exists

Structural reports omit model output and verification stdout/stderr; they contain paths to the
separate artifacts.
```

- [ ] **Step 6: Run docs, plugin, and focused release-contract checks**

Run:

```powershell
npm.cmd test -- public-release-contract.test.ts packaged-skill.test.ts plugin-validator.test.ts
npm.cmd run build
npm.cmd run validate:plugin
```

Expected: PASS. If plugin validation requires a description adjustment, merge a minimal wording change into the already dirty `.codex-plugin/plugin.json`; do not change its version solely for this source plan.

- [ ] **Step 7: Run the complete verification suite**

Run:

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
npm.cmd run validate:plugin
```

Expected:

```text
Vitest: all tests passed
TypeScript lint: exit 0
Build: exit 0
Plugin validation: exit 0
```

Inspect the final diff and confirm:

- No default `mimo_result` or automatic callback path serializes `output`.
- Only `level: "full"` reads complete semantic/diagnostic artifacts.
- Compact result fixtures remain within 6,000 UTF-8 bytes.
- Planning output exists in `.plan.md`.
- Structural reports do not inline model text or verification stdout/stderr.
- Existing unrelated working-tree edits remain intact.

- [ ] **Step 8: Conditional final commit**

Only if explicitly authorized:

```powershell
git add skills/mimocode/SKILL.md README.md doc/operations-guide.md doc/compose-workflows.md test/unit/public-release-contract.test.ts test/unit/packaged-skill.test.ts
git commit -m "docs(results): publish compact delivery contract"
```

## Phase 1 Completion Gate

Phase 1 is complete only when:

- default MCP status is a short heartbeat object;
- default MCP result is compact and no larger than 6,000 UTF-8 bytes;
- CLI status remains useful through its standard default;
- full plan/result/verification artifacts are persisted before terminal transition;
- `level: "full"` restores explicit detailed diagnostics;
- callback V2 contains no output body;
- all focused tests, full tests, lint, build, and plugin validation pass.

Do not begin the Phase 2 effective-progress/stall/resume plan until this gate is verified.
