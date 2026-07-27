# Codex-MiMo Ordered Development Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require host-gated, fail-fast acceptance (`build` → `test` → `diff_check`) before any `dev` / `execute-plan` (and direct `implement`) job can be marked `completed`, with stage-specific failure codes, full evidence in artifacts, and compact failure summaries that name the first failed stage/command and a shortest repair suggestion.

**Architecture:** Introduce a staged acceptance runner that reuses `execa` without a shell. Legacy `verification[]` maps only to the test stage. Deterministic diff checks live in post-checks; an optional read-only MiMo verdict pass closes the diff stage. Finalizers for write workflows call the runner after MiMo exit/`session.post` and refuse `completed` when any required stage fails or when acceptance config is missing. Phase 4 slice chains are out of scope: treat each write job as a single acceptance unit with no `allowedPaths` unless explicitly provided.

**Tech Stack:** TypeScript NodeNext ESM, Zod, Vitest, existing `compose/verify.ts`, `compose/post-checks.ts`, job finalizers, checkpoint `acceptance.stages`, compact result rendering.

## Global Constraints

- This plan implements design Rollout **Phase 3 only**: ordered development acceptance.
- Do **not** implement Phase 4 durable automatic slice chains, `batchMode`, or multi-slice manifests.
- Preserve Phase 1 compact delivery and Phase 2 stall/checkpoint/resume behavior.
- Defaults and budgets from prior phases remain: compact ≤ 6,000 bytes; `progressTimeoutMs` default 300_000; `idleTimeoutMs` 1_800_000.
- Fail-fast between stages: failed build skips test and diff; failed tests skip diff.
- A `dev` / `execute-plan` / `implement` job must not reach `completed` with empty acceptance or only legacy unconstrained `needs_review`.
- Legacy `verification[]` maps to the **test** stage only; it does not satisfy build.
- Host validates commands are executable without a shell (whitespace-split `execa`, same as today).
- Full stdout/stderr stay in `.verification.json` / acceptance evidence; compact results expose only bounded fields + `failedStage` / `failedCommand` / `failedTests` / `suggestion`.
- Emit stage-specific codes: `acceptance_config_missing`, `build_failed`, `tests_failed`, `diff_check_failed`, `delivery_contract_missing` (for malformed review verdict).
- `RESUMABLE_FAILURE_CODES` already includes `build_failed` / `tests_failed` / `diff_check_failed`; ensure failed acceptance jobs are resumable via existing Phase 2 resume path.
- When no slice manifest exists, skip `allowedPaths` scope comparison and record that sub-check as `not_applicable` with reason `no_slice_allowed_paths`.
- Use `.js` import extensions; exported named return types; no new dependencies.
- Use `npm.cmd` on Windows.
- Do not create a Git commit unless the user explicitly authorizes commits.
- Re-read and merge dirty docs on `feat/compact-results-artifacts`; do not wholesale replace Phase 1/2 guidance.
- Do not modify historical 2026-07-20 through 2026-07-23 specs/plans.

---

## File Structure

- `src/compose/acceptance.ts` (**new**): plan normalization, build/test discovery, ordered runner, failure extraction, suggestion helpers.
- `src/compose/verify.ts`: keep low-level command execution; optionally export helpers reused by acceptance.
- `src/compose/post-checks.ts`: deterministic diff self-check functions (`git diff --check`, conflict markers, unexpected commits, generated-artifact heuristics).
- `src/compose/workflow.ts`: mark which workflows require development acceptance.
- `src/core/job-definitions.ts`: wire acceptance into `finalizeCompose` / `finalizeDirect` for write jobs; populate checkpoint acceptance stages.
- `src/core/job-outcome.ts`: accept stage-aware failure codes / optional acceptance results.
- `src/core/job-render.ts`: stop hard-coding `stage: "test"`; use real `CompactAcceptanceResult[]`; fill `failedStage` / `failedTests` / `suggestion`.
- `src/core/job-checkpoint.ts`: write real acceptance stages into checkpoints.
- `src/codex/tool-schemas.ts` / `job-definitions` request schemas: `acceptance?: { build?, test?, diffCheck? }`.
- `src/codex/mcp-server.ts` + plugin validator: document acceptance fields.
- Docs/skill/contract tests.

---

### Task 1: Acceptance request schema and workflow flags

**Files:**
- Modify: `src/compose/workflow.ts`
- Modify: `src/codex/tool-schemas.ts`
- Modify: `src/core/job-definitions.ts` (`ComposeRequestSchema`, optionally `ImplementRequestSchema`)
- Modify: `scripts/validate-plugin.mjs` + `test/unit/plugin-validator.test.ts`
- Modify: `test/unit/tool-schemas.test.ts`
- Modify: `test/unit/compose-workflow.test.ts`

**Interfaces:**

```ts
export interface DevelopmentAcceptanceInput {
  build?: string[];
  test?: string[];
  diffCheck?: boolean; // default true for acceptance workflows
}

export function workflowRequiresDevelopmentAcceptance(
  workflow: ComposeWorkflowName
): boolean {
  return workflow === "dev" || workflow === "execute-plan";
}
```

- [ ] **Step 1: Write failing schema tests**

```ts
it("parses compose acceptance and defaults diffCheck true for callers that omit it at normalize time", () => {
  const parsed = ComposeInput.parse({
    cwd: "E:/project",
    workflow: "dev",
    task: "add endpoint",
    acceptance: { test: ["npm test -- foo.test.ts"] }
  });
  expect(parsed.acceptance).toEqual({
    test: ["npm test -- foo.test.ts"]
  });
});

it("still accepts legacy verification[] for migration", () => {
  const parsed = ComposeInput.parse({
    cwd: "E:/project",
    workflow: "dev",
    task: "x",
    verification: ["npm test"]
  });
  expect(parsed.verification).toEqual(["npm test"]);
});
```

- [ ] **Step 2: Run and verify failure**

```powershell
npm.cmd test -- tool-schemas.test.ts compose-workflow.test.ts
```

- [ ] **Step 3: Implement schema + flags**

Add optional `acceptance` to Compose (and Implement) inputs with Zod:

```ts
const DevelopmentAcceptanceSchema = z.object({
  build: z.array(z.string().min(1)).optional(),
  test: z.array(z.string().min(1)).optional(),
  diffCheck: z.boolean().optional()
}).strict();
```

Mirror in plugin validator canonical compose schema.

- [ ] **Step 4: Verify + conditional commit**

```powershell
npm.cmd test -- tool-schemas.test.ts compose-workflow.test.ts plugin-validator.test.ts
npm.cmd run lint
```

Only if authorized: commit `feat(acceptance): add development acceptance request schema`.

---

### Task 2: Build/test command discovery and plan normalization

**Files:**
- Create: `src/compose/acceptance.ts` (discovery + normalize first; runner in Task 3)
- Create: `test/unit/compose/acceptance-plan.test.ts`
- Modify: `src/compose/verify.ts` only if sharing detect helpers

**Interfaces:**

```ts
export interface AcceptanceStagePlan {
  stage: "build" | "test" | "diff_check";
  commands: string[]; // empty + notApplicableReason means N/A for build
  notApplicableReason?: string;
  required: boolean;
}

export interface DevelopmentAcceptancePlan {
  stages: AcceptanceStagePlan[];
  source: "explicit" | "detected" | "legacy_verification" | "mixed";
}

export function normalizeDevelopmentAcceptancePlan(input: {
  cwd: string;
  acceptance?: DevelopmentAcceptanceInput;
  legacyVerification?: string[];
  requireAcceptance: boolean;
}): DevelopmentAcceptancePlan | { missing: true; reason: string; code: "acceptance_config_missing" };
```

Discovery rules:

- **Build:** explicit `acceptance.build` if non-empty; else detect `npm run build` when `package.json` scripts.build exists; `tsc -p tsconfig.json --noEmit` when `tsconfig.json` exists and no build script; `cargo build` / `go build ./...` / Maven/Gradle when those manifests exist; else `not_applicable` with fixed reason `non_compiled_or_no_build_tooling` for recognized JS test-only trees; if `requireAcceptance` and neither build nor N/A can be established → missing.
- **Test:** explicit `acceptance.test`; else legacy `verification[]`; else existing `detectVerificationCommands`; if `requireAcceptance` and still empty → missing.
- **Diff:** `acceptance.diffCheck !== false` means required deterministic (+ review) stage with `commands: []` (host-internal).

- [ ] **Step 1: Failing discovery tests**

Cover: package build script preferred; legacy verification maps to test only; empty test with requireAcceptance → missing; build N/A for pytest-only tree.

- [ ] **Step 2–4: Implement, verify, conditional commit**

```powershell
npm.cmd test -- acceptance-plan.test.ts
npm.cmd run lint
```

---

### Task 3: Fail-fast staged command runner + failure extraction

**Files:**
- Modify: `src/compose/acceptance.ts`
- Modify: `src/compose/verify.ts` (reuse `runVerificationCommands` or internal executor)
- Create: `test/unit/compose/acceptance-runner.test.ts`

**Interfaces:**

```ts
export interface AcceptanceStageResult {
  stage: "build" | "test" | "diff_check";
  outcome: "passed" | "failed" | "not_applicable" | "skipped";
  command?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  reason?: string;
  failedTests?: string[];
  suggestion?: string;
}

export interface DevelopmentAcceptanceResult {
  stages: AcceptanceStageResult[];
  passed: boolean;
  errorCode?: "build_failed" | "tests_failed" | "diff_check_failed" | "delivery_contract_missing";
  failedStage?: "build" | "test" | "diff_check";
  failedCommand?: string;
  failedTests?: string[];
  suggestion?: string;
  compactTests: CompactAcceptanceResult[];
  verificationDetails: JobVerificationDetails[];
}

export async function runDevelopmentAcceptance(
  cwd: string,
  plan: DevelopmentAcceptancePlan,
  options: {
    signal?: AbortSignal;
    runDiffCheck?: (cwd: string, signal?: AbortSignal) => Promise<AcceptanceStageResult>;
    execute?: VerificationCommandExecutor;
  }
): Promise<DevelopmentAcceptanceResult>;
```

Behavior:

1. Run build commands sequentially; on first failure set `build_failed`, mark later stages `skipped`.
2. Run test commands; on failure `tests_failed`.
3. Call `runDiffCheck` if planned; map failure codes from diff helper.
4. `compactTests`: first result per stage via existing `firstResultPerStage` pattern.
5. Extract failed test names with lightweight adapters (Vitest/Jest `FAIL|×|●`, pytest `FAILED`, cargo/go heuristics); suggestion templates from design examples.

- [ ] **Step 1: Failing runner tests**

```ts
it("skips tests when build fails", async () => { ... });
it("maps legacy verification failure to tests_failed", async () => { ... });
it("extracts vitest failed test names into suggestion", async () => { ... });
```

- [ ] **Step 2–4: Implement, verify, conditional commit**

```powershell
npm.cmd test -- acceptance-runner.test.ts compose-verify.test.ts
```

---

### Task 4: Deterministic diff self-check

**Files:**
- Modify: `src/compose/post-checks.ts`
- Create: `test/unit/compose/diff-acceptance.test.ts`

**Interfaces:**

```ts
export interface DiffAcceptanceInput {
  cwd: string;
  changedFiles: string[];
  allowedPaths?: string[]; // omit => skip scope check as not_applicable
  gitHeadBefore?: GitHeadSnapshot;
  gitHeadAfter?: GitHeadSnapshot;
  commitChanges?: GitCommitChangeSnapshot;
  diffText?: string;
  signal?: AbortSignal;
}

export async function runDeterministicDiffAcceptance(
  input: DiffAcceptanceInput
): Promise<AcceptanceStageResult>;
```

Checks (fail-fast internally, aggregate first failure):

1. Run `git diff --check` via execa (`git`, `["diff", "--check"]`).
2. If `allowedPaths` provided, fail when any `changedFiles` is outside the allowlist (`diff_check_failed`, suggestion to remove out-of-scope file).
3. If commits appeared unexpectedly (`commitChanges.commits` non-empty when policy forbids commits — default forbid for acceptance jobs), fail.
4. Scan `diffText` / changed files for conflict markers `<<<<<<<` / `>>>>>>>`.
5. Heuristic reject of accidental artifacts (e.g. `node_modules/`, `.next/`, `dist/` when not in allowlist).

Return `outcome: "passed"` or `failed` with `suggestion` like `Remove out-of-scope change README.md, then rerun the diff check.`

- [ ] **Step 1: Failing tests** for `--check` failure, scope violation, conflict marker, unexpected commit.
- [ ] **Step 2–4: Implement, verify, conditional commit**

```powershell
npm.cmd test -- diff-acceptance.test.ts
```

---

### Task 5: Read-only MiMo diff review verdict (host-gated)

**Files:**
- Modify: `src/compose/acceptance.ts` or new `src/compose/diff-review.ts`
- Modify: `src/core/job-definitions.ts` / worker finalize deps
- Modify: `src/core/prompt.ts` — `diffReviewPrompt(diffPath)`
- Tests: `test/unit/compose/diff-review.test.ts`

**Interfaces:**

```ts
export interface DiffReviewVerdict {
  verdict: "pass" | "fail";
  findings: Array<{ severity: "blocker" | "major" | "minor" | "info"; message: string; path?: string }>;
}

export function parseDiffReviewVerdict(finalText: string): DiffReviewVerdict | null;

export async function runReadOnlyDiffReview(input: {
  cwd: string;
  sessionId?: string | null;
  diffPath: string;
  signal?: AbortSignal;
  runMimo?: typeof runMimoCliStreaming; // injectable
}): Promise<AcceptanceStageResult>;
```

Behavior for Phase 3:

1. If no diff / no changed files, treat review as `not_applicable` with reason `no_diff`.
2. Otherwise launch a **read-only** MiMo run (`agent: plan` or compose review skill) with prompt requiring a single JSON verdict envelope in final text; reuse `sessionId` when present.
3. Capture git status before/after; any write → fail `diff_check_failed`.
4. Missing/malformed JSON → `delivery_contract_missing`.
5. `verdict: "fail"` with blocker/major → `diff_check_failed`; minor/info may pass with warnings recorded in verification details only.

**Pragmatism for testability:** default production path runs MiMo; unit tests inject `runMimo` fake returning controlled final text. Integration test may use existing fake-process harness.

If running an extra MiMo review is too heavy for a given finalize path, the plan still requires the hook to exist; compose finalize must call it when `diffCheck` is required and diff exists.

- [ ] **Step 1: Failing parse + injected runner tests**
- [ ] **Step 2–4: Implement, verify, conditional commit**

---

### Task 6: Wire finalizers — refuse completed without acceptance

**Files:**
- Modify: `src/core/job-definitions.ts` (`finalizeCompose`, `finalizeDirect` for implement)
- Modify: `src/core/job-outcome.ts` if needed
- Modify: `src/core/job-checkpoint.ts` / finalizer checkpoint write to store stages
- Modify: `src/core/job-render.ts` — use real stages; populate failure fields
- Modify: `test/unit/core/job-definitions.test.ts`
- Modify: `test/unit/job-render.test.ts`
- Modify: `test/integration/unified-background-jobs.test.ts`

**Rules:**

1. For `workflowRequiresDevelopmentAcceptance` or `kind === "implement"`:
   - Build plan via `normalizeDevelopmentAcceptancePlan`.
   - If missing → outcome `needs_input` + `acceptance_config_missing` (prefer before MiMo when possible; at minimum during finalize before `completed`). **Phase 3 minimum:** gate in finalize so empty verification can no longer complete. Optional follow-up: pre-flight in worker before spawn.
2. Run `runDevelopmentAcceptance` after MiMo success path / alongside existing verification.
3. On failure → `status: "failed"` with stage error code; store full details in verification artifact; compact job verification without stdout.
4. On success → only then allow `classifyRunOutcome` completed (still subject to callback/read-only rules).
5. Remove `composeReportStatus` loophole: for acceptance workflows, empty verification + changes ⇒ failed acceptance, not `needs_review`.
6. Update checkpoint `acceptance.stages` from results.
7. `renderCompactJobResult`: map `compactTests` from acceptance; set `failure.failedStage` / `failedTests` / `suggestion`.

- [ ] **Step 1: Failing finalizer tests**

```ts
it("does not complete compose dev with zero acceptance commands", async () => {
  // mocked run → finalize → status failed or needs_input with acceptance_config_missing
});

it("fails finalize on build stage and skips tests", async () => { ... });

it("completes only after build, test, and diff checks pass", async () => { ... });
```

- [ ] **Step 2–4: Implement, verify**

```powershell
npm.cmd test -- job-definitions.test.ts job-render.test.ts unified-background-jobs.test.ts
npm.cmd run lint
```

Conditional commit: `feat(acceptance): gate write-job completion on ordered stages`.

---

### Task 7: Docs, contracts, and release verification

**Files:**
- Modify carefully: `skills/mimocode/SKILL.md`, `README.md`, `doc/operations-guide.md`, `doc/compose-workflows.md`
- Modify: `test/unit/public-release-contract.test.ts`, `test/unit/packaged-skill.test.ts`
- Modify: `src/codex/mcp-server.ts` tool descriptions

**Document:**

- `acceptance.build` / `acceptance.test` / `acceptance.diffCheck`
- Ordered fail-fast stages and error codes
- Legacy `verification[]` → test stage only
- `dev` / `execute-plan` / `implement` cannot complete without acceptance
- Compact failure fields and resume via Phase 2 for `build_failed` / `tests_failed` / `diff_check_failed`
- Preserve compact defaults + stall/checkpoint guidance

- [ ] **Step 1: Update contract tests first (expect fail)**
- [ ] **Step 2: Update docs surgically**
- [ ] **Step 3: Full verification**

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
npm.cmd run validate:plugin
```

Conditional commit: `docs(acceptance): publish ordered development acceptance contract`.

---

## Self-review (controller)

1. **Spec coverage:** request contract, discovery, ordered stages, diff self-check, review verdict, completion predicate (single-job unit), failure summary/suggestion, resumable codes — mapped to Tasks 1–7.
2. **Out of scope:** slice manifests, batchMode, multi-slice root aggregation — deferred to Phase 4; `allowedPaths` optional only.
3. **Phase 1/2 preserved:** compact delivery + stall/resume called out in Global Constraints and Task 7.
4. **No placeholders / TBD.**
5. **Pre-edit `acceptance_config_missing`:** Phase 3 minimum is finalize-time gate; optional worker preflight noted — acceptable for first ship, document honestly in Task 6.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-26-codex-mimo-ordered-acceptance.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task + review between tasks  
2. **Inline Execution** — this session with executing-plans checkpoints  

Which approach?
