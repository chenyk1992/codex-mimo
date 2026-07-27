# Codex-MiMo Durable Slice Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn broad write objectives into a durable sequential slice chain: accept `batchMode`, validate a slice manifest, execute one dependency-ready write slice at a time under the existing workspace supervisor lock, aggregate root progress, notify only on the root, and recover without duplicating completed or live children.

**Architecture:** Keep the public root job (`compose` `dev`/`execute-plan` or `implement`) as the only notification owner. When `batchMode !== "single"`, a bounded read-only planning pass produces a `SliceManifest` saved to `.codex-mimo/reports/<rootId>.slices.json` before any write. A `JobChainRecord` under `.codex-mimo/jobs/<chainId>.chain.json` tracks slice states. Internal child jobs reuse existing `compose`/`implement` definitions with `parentJobId`, `chainId`, and `sliceId`; they launch with `notificationTarget: null`. After each child terminal transition, the chain coordinator marks the slice, refreshes root aggregate fields, and either starts the next ready slice or finalizes the root. Phase 3 ordered acceptance remains the per-slice completion gate (`allowedPaths` enforced when present).

**Tech Stack:** TypeScript NodeNext ESM, Zod, Vitest, existing job launcher/supervisor/worker/transition, Phase 3 `acceptance.ts` / `runDevelopmentAcceptance`, Phase 2 checkpoint/resume.

## Global Constraints

- This plan implements design Rollout **Phase 4 only**: durable automatic slice chain / `batchMode`.
- Preserve Phase 1 compact delivery, Phase 2 stall/checkpoint/resume, and Phase 3 ordered acceptance.
- Defaults: compact ≤ 6,000 bytes; `progressTimeoutMs` 300_000; `idleTimeoutMs` 1_800_000; `batchMode` default `"auto"`.
- Never run two write slices concurrently in the same workspace, even if the dependency graph would allow it.
- Internal children do **not** inherit or enqueue external Codex/webhook notifications; only the root delivers.
- A root completes only when every slice is `completed`. Slice failure/stall/needs_input/blocked/timeout leaves later slices `pending` and mirrors attention onto the root.
- Completed slices are never relaunched. Live child processes are not duplicated on supervisor restart.
- Manifest validation fails closed with `slice_plan_invalid` before write work begins.
- `batchMode: "single"` skips planning decomposition and materializes one slice from the root request (still runs Phase 3 acceptance).
- `batchMode: "sliced"` requires ≥ 2 slices after planning or fails with `slice_plan_invalid`.
- `auto` may return one slice; one-slice chains incur no extra chain behavior beyond acceptance.
- Enable `auto` default only with crash-recovery + duplicate-start tests green (Task 7–8). Until then, keep feature wired but do not weaken existing single-job paths for `batchMode: "single"` callers.
- Use `.js` import extensions; exported named return types; no new dependencies.
- Use `npm.cmd` on Windows.
- Do not create a Git commit unless the user explicitly authorizes commits.
- Re-read and merge dirty docs on `feat/compact-results-artifacts`; do not wholesale replace Phase 1–3 guidance.
- Do not modify historical 2026-07-20 through 2026-07-23 specs/plans.

---

## File Structure

- `src/core/jobs.ts`: `batchMode` types; optional `chainId` / `sliceId` on `JobRecord`; `JobReportPaths.slices`; standard result already has `completedSlices` / `remainingSlices`.
- `src/codex/tool-schemas.ts` + `job-definitions` request schemas: `batchMode` on implement/compose write entries.
- `src/compose/slices.ts` (**new**): `SliceManifest` / `SliceDefinition` types, `validateSliceManifest`, `materializeSingleSliceManifest`, `parseSliceManifestFromText`, `selectNextReadySlice`.
- `src/core/prompt.ts`: `slicePlanningPrompt(objective)`.
- `src/core/job-chain.ts` (**new**): `JobChainRecord` read/write, atomic slice state transitions, root aggregate helpers.
- `src/core/job-definitions.ts`: planning finalize for chain roots; slice child binding; root finalization aggregation; suppress notify for children (via null target at launch).
- `src/core/job-launcher.ts` / work tools: accept `batchMode`; for chain roots, create root then enter planning/slice spawn path.
- `src/core/job-worker.ts` / `job-supervisor.ts`: after child terminal, call chain advance; treat unfinished chains as durable work.
- `src/core/job-checkpoint.ts`: persist `sliceId` / `completedSlices` from chain.
- `src/core/job-render.ts`: fill `completedSlices` / `remainingSlices` on standard; compact root attention for `slice_failed`.
- `src/codex/tools.ts`: resume root or current slice child appropriately; `slice_plan_invalid` / `slice_failed` codes.
- Docs/skill/contract + integration fake-MiMo two-slice test.

---

### Task 1: `batchMode` schema and chain/slice job fields

**Files:**
- Modify: `src/core/jobs.ts`
- Modify: `src/codex/tool-schemas.ts`
- Modify: `src/core/job-definitions.ts` (`CommonRequestSchema` / Implement / Compose)
- Modify: `src/core/job-store.ts` (persist/validate optional `chainId`, `sliceId`)
- Modify: `src/core/job-artifacts.ts` (`reportPaths.slices`)
- Modify: `test/unit/tool-schemas.test.ts`
- Modify: `test/unit/job-store.test.ts`

**Interfaces:**

```ts
export type BatchMode = "auto" | "single" | "sliced";

// JobRecord additions (optional):
chainId?: string | null;
sliceId?: string | null;

// JobReportPaths:
slices?: string;
```

Zod:

```ts
batchMode: z.enum(["auto", "single", "sliced"]).default("auto")
```

Add to `ImplementInput` and compose write workflows (`dev`, `execute-plan`). Read-only workflows ignore / reject `batchMode` if present (prefer ignore with strip, or refine reject — choose ignore for compatibility).

- [ ] **Step 1: Failing tests** for schema default `auto`, parse `single`/`sliced`, store round-trip of `chainId`/`sliceId`, `reportPaths.slices` normalize.

- [ ] **Step 2: Implement fields + schemas**

- [ ] **Step 3: Verify**

```powershell
npm.cmd test -- tool-schemas.test.ts job-store.test.ts
npm.cmd run lint
```

- [ ] **Step 4: Conditional commit** `feat(slices): add batchMode schema and chain job fields` (skip unless user authorizes)

---

### Task 2: SliceManifest types and validation

**Files:**
- Create: `src/compose/slices.ts`
- Create: `test/unit/compose/slice-manifest.test.ts`

**Interfaces:**

```ts
export interface SliceDefinition {
  id: string;
  title: string;
  objective: string;
  dependsOn: string[];
  contextFiles: string[];
  allowedPaths: string[];
  acceptance: DevelopmentAcceptanceInput;
}

export interface SliceManifest {
  version: 1;
  chainId: string;
  objective: string;
  repositoryFingerprint: string;
  slices: SliceDefinition[];
}

export type SliceManifestValidation =
  | { ok: true; manifest: SliceManifest }
  | { ok: false; code: "slice_plan_invalid"; reason: string };

export function validateSliceManifest(
  input: unknown,
  options?: { minSlices?: number; maxSlices?: number }
): SliceManifestValidation;

export function materializeSingleSliceManifest(input: {
  chainId: string;
  objective: string;
  repositoryFingerprint: string;
  acceptance: DevelopmentAcceptanceInput;
  allowedPaths?: string[];
  contextFiles?: string[];
}): SliceManifest;
```

Validation rules (fail closed):

1. `version === 1`
2. 1–8 slices (or `minSlices`/`maxSlices` override; `sliced` uses `minSlices: 2`)
3. Unique non-empty `id`s
4. Acyclic `dependsOn`; every dep refers to a manifest slice
5. Non-empty `title`, `objective`, `allowedPaths` (≥1), and acceptance with build disposition + ≥1 test (reuse `normalizeDevelopmentAcceptancePlan` with `requireAcceptance: true`)
6. Paths are repository-relative strings (reject absolute / `..` traversal)

- [ ] **Step 1: Failing tests** for happy path, cycle, missing acceptance, >8 slices, bad dep, absolute path, `materializeSingleSliceManifest`

- [ ] **Step 2: Implement `src/compose/slices.ts`**

- [ ] **Step 3: Verify**

```powershell
npm.cmd test -- slice-manifest.test.ts
npm.cmd run lint
```

---

### Task 3: Planner prompt, parse, and single-slice materialize path

**Files:**
- Modify: `src/core/prompt.ts` — `slicePlanningPrompt(objective: string): string`
- Modify: `src/compose/slices.ts` — `parseSliceManifestFromText(finalText: string): unknown | null`
- Create: `test/unit/compose/slice-planning.test.ts`
- Modify: `test/unit/core/prompt-builders.test.ts` (if present)

**Behavior:**

1. Prompt requires a single JSON `SliceManifest` envelope in final text (no write tools; read-only plan agent).
2. `parseSliceManifestFromText` extracts JSON object (same robustness style as `parseDiffReviewVerdict`).
3. Helper used by later tasks:

```ts
export async function planSliceManifest(input: {
  cwd: string;
  chainId: string;
  objective: string;
  batchMode: BatchMode;
  acceptance?: DevelopmentAcceptanceInput;
  legacyVerification?: string[];
  repositoryFingerprint: string;
  signal?: AbortSignal;
  runMimo?: typeof runMimoCliStreaming; // injectable
}): Promise<
  | { ok: true; manifest: SliceManifest }
  | { ok: false; code: "slice_plan_invalid"; reason: string }
>
```

- `batchMode === "single"` → `materializeSingleSliceManifest` (no MiMo plan).
- Else run read-only MiMo plan → parse → `validateSliceManifest` with `minSlices: batchMode === "sliced" ? 2 : 1`.
- On parse/validate failure → `{ ok: false, code: "slice_plan_invalid", ... }`.

- [ ] **Step 1: Failing parse + prompt + planSliceManifest injection tests**

- [ ] **Step 2: Implement**

- [ ] **Step 3: Verify**

```powershell
npm.cmd test -- slice-planning.test.ts prompt-builders.test.ts
npm.cmd run lint
```

---

### Task 4: Chain store and `slices.json` artifact

**Files:**
- Create: `src/core/job-chain.ts`
- Create: `test/unit/core/job-chain.test.ts`
- Modify: `src/core/job-artifacts.ts` / report path helpers as needed

**Interfaces:**

```ts
export type SliceRuntimeState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "stalled"
  | "needs_input"
  | "blocked"
  | "cancelled"
  | "timeout";

export interface JobChainRecord {
  version: 1;
  chainId: string;
  rootJobId: string;
  latestContinuationJobId?: string;
  manifestPath: string;
  sliceStates: Record<string, SliceRuntimeState>;
  currentSliceId?: string;
  completedSliceIds: string[];
  childJobIds: Record<string, string>; // sliceId -> jobId
}

export function resolveChainPath(cwd: string, chainId: string): string;
export function readJobChain(cwd: string, chainId: string): JobChainRecord | null;
export function writeJobChainAtomic(cwd: string, record: JobChainRecord): void;

export function createJobChainFromManifest(input: {
  cwd: string;
  rootJobId: string;
  manifest: SliceManifest;
  manifestPath: string;
}): JobChainRecord;

export function markSliceRunning(
  cwd: string,
  chainId: string,
  sliceId: string,
  childJobId: string
): JobChainRecord;

export function markSliceTerminal(
  cwd: string,
  chainId: string,
  sliceId: string,
  state: Exclude<SliceRuntimeState, "pending" | "running">
): JobChainRecord;

export function writeSliceManifestArtifact(input: {
  cwd: string;
  rootJobId: string;
  manifest: SliceManifest;
}): string; // returns absolute/path under .codex-mimo/reports/<id>.slices.json
```

`selectNextReadySlice(manifest, chain)` returns first manifest-order slice whose deps are all `completed` and whose state is `pending`, else `null`.

- [ ] **Step 1: Failing atomic write / mark / selectNextReadySlice tests**

- [ ] **Step 2: Implement**

- [ ] **Step 3: Verify**

```powershell
npm.cmd test -- job-chain.test.ts
npm.cmd run lint
```

---

### Task 5: Root launch → plan → first slice; suppress child notifications

**Files:**
- Modify: `src/core/job-definitions.ts` (root chain bootstrap in compose/implement bind or finalize/prepare)
- Modify: `src/core/job-launcher.ts` and/or work-tool handlers if bootstrap belongs at launch
- Modify: `src/core/job-worker.ts` as needed for planning phase
- Modify: `test/unit/core/job-definitions.test.ts`
- Modify: `test/unit/core/job-launcher.test.ts` (if present)

**Preferred flow (keep under workspace lock via supervisor/worker):**

1. Public root job created as today (with notify target if any). Root `request.batchMode` read.
2. If write workflow + `batchMode`:
   - Root enters a planning/bootstrap phase (no write MiMo yet).
   - Call `planSliceManifest` (injectable in tests).
   - On failure → root `failed` / `needs_input` with `slice_plan_invalid` (use `failed` for invalid plan; `needs_input` only if planner asks clarifying questions — Phase 4 minimum: `failed` + `slice_plan_invalid`).
   - On success → write slices artifact, `createJobChainFromManifest`, set root `chainId`, `reportPaths.slices`.
3. Spawn first ready slice child via `launchJob` / store.create with:
   - `parentJobId: root.id`
   - `chainId`, `sliceId`
   - `notificationTarget: null` (explicit)
   - request = focused slice objective + slice `acceptance` + `allowedPaths`
   - kind/workflow matching root write type (`compose`+`dev` or `implement`)
4. `markSliceRunning`; root stays `running` with summary like `Executing slice 1/N: <title>`.

For `batchMode: "single"`, skip MiMo planning; still create one-slice chain so aggregation/resume paths are uniform.

- [ ] **Step 1: Failing tests**
  - single mode creates one child with null notify
  - invalid plan fails root with `slice_plan_invalid` before any child
  - first child has `parentJobId` + `sliceId`

- [ ] **Step 2: Implement bootstrap**

- [ ] **Step 3: Verify**

```powershell
npm.cmd test -- job-definitions.test.ts job-launcher.test.ts
npm.cmd run lint
```

---

### Task 6: Advance chain on child terminal + root aggregate + attention

**Files:**
- Create or modify: `src/core/job-chain.ts` — `advanceJobChainAfterChild(...)`
- Modify: `src/core/job-worker.ts` or `job-transition.ts` hook after child terminal
- Modify: `src/core/job-render.ts` — `completedSlices` / `remainingSlices`; root compact attention for mid-chain failure
- Modify: `src/core/job-supervisor.ts` — unfinished chain counts as durable work even if root is running and child list empty briefly
- Modify: `test/unit/core/job-chain.test.ts`
- Modify: `test/unit/core/job-definitions.test.ts` / worker tests

**`advanceJobChainAfterChild` behavior:**

```ts
export async function advanceJobChainAfterChild(input: {
  cwd: string;
  child: JobRecord;
}): Promise<{
  root: JobRecord;
  startedChildId?: string;
  rootTerminal?: boolean;
}>
```

1. Ignore non-chain children (`!child.chainId || !child.sliceId || !child.parentJobId`).
2. Map child status → slice state (`completed` / `failed` / `stalled` / …).
3. `markSliceTerminal`.
4. Aggregate onto root: union `changedFiles`, append compact acceptance summaries, update checkpoint `completedSlices`.
5. If child not successfully completed → transition root to matching attention status (`failed`+`slice_failed` or mirror `stalled`/`needs_input`/…), enqueue **root** notification only; do not start next slice.
6. If completed and `selectNextReadySlice` non-null → launch next child (null notify), `markSliceRunning`, keep root `running`.
7. If completed and no remaining → finalize root `completed` with aggregated artifacts; enqueue root notification.

Never start next slice before previous terminal transition is durable.

- [ ] **Step 1: Failing tests** for two-slice advance, failure leaves later pending, no child notify enqueue, root aggregate changedFiles

- [ ] **Step 2: Implement advance + hooks**

- [ ] **Step 3: Verify**

```powershell
npm.cmd test -- job-chain.test.ts job-definitions.test.ts job-worker.test.ts job-render.test.ts
npm.cmd run lint
```

---

### Task 7: Crash recovery and resume across slices

**Files:**
- Modify: `src/core/job-supervisor.ts` / `job-recovery.ts` as needed
- Modify: `src/codex/tools.ts` (`mimo_resume`)
- Modify: `src/core/job-checkpoint.ts` (slice fields)
- Modify: `test/unit/mcp-tools/mimo-resume.test.ts`
- Modify: `test/unit/core/job-supervisor.test.ts`

**Rules:**

1. Unfinished `JobChainRecord` ⇒ durable work (supervisor stays alive).
2. Completed slice never relaunched (`sliceStates[id] === "completed"`).
3. `running` slice with live worker/process → reattach / leave owned (existing ownership).
4. `running` slice without live process → mark stalled/failed with evidence; mirror root attention.
5. `mimo_resume` on root attention mid-chain resumes the **current** failed/stalled slice child (or creates continuation child linked as `latestContinuationJobId`), skipping completed slices; checkpoint lists `completedSlices` as do-not-repeat.
6. `resume_conflict` still applies via repository fingerprint on manifest/checkpoint.

- [ ] **Step 1: Failing tests** for no duplicate completed relaunch; resume skips completed slice; dead running → stalled

- [ ] **Step 2: Implement**

- [ ] **Step 3: Verify**

```powershell
npm.cmd test -- mimo-resume.test.ts job-supervisor.test.ts job-chain.test.ts
npm.cmd run lint
```

---

### Task 8: Integration fake-MiMo chain + docs + release verify

**Files:**
- Modify: `test/integration/unified-background-jobs.test.ts` (or new `test/integration/slice-chain.test.ts`)
- Modify carefully: `skills/mimocode/SKILL.md`, `README.md`, `doc/operations-guide.md`, `doc/compose-workflows.md`
- Modify: `test/unit/public-release-contract.test.ts`, `test/unit/packaged-skill.test.ts`
- Modify: `src/codex/mcp-server.ts` tool descriptions

**Integration scenario (spec § Testing strategy / Slice chain):**

1. Fake two-slice manifest (`batchMode: "sliced"` or injected plan).
2. Complete first slice (acceptance pass).
3. Stall second after productive edits (fake clock / injected progress timeout).
4. Root compact result shows attention + resume; no child notification delivery.
5. Resume skips slice 1; completes slice 2 acceptance.
6. Root `completed`; compact ≤ 6,000 bytes; `completedSlices`/`remainingSlices` correct on standard.

**Document:**

- `batchMode` auto/single/sliced
- Manifest + chain record locations
- One-slice-at-a-time rule; root-only notifications
- `slice_plan_invalid` / `slice_failed`
- Resume skips completed slices
- Preserve Phase 1–3 compact/stall/acceptance guidance

- [ ] **Step 1: Contract/skill test updates**

- [ ] **Step 2: Docs + integration**

- [ ] **Step 3: Full verification**

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
npm.cmd run validate:plugin
```

---

## Self-review (controller)

1. **Spec coverage:** `batchMode`, manifest validation, durable chain record, sequential execution, root-only notify, crash/idempotency, root completion predicate, aggregate results, failure codes `slice_plan_invalid`/`slice_failed`, resume across slices, integration scenario — mapped to Tasks 1–8.
2. **Out of scope:** general DAG parallel writes, rollback of earlier slices, cross-workspace scheduling.
3. **Phase 1–3 preserved:** called out in Global Constraints and Task 8.
4. **No placeholders / TBD.**
5. **Type consistency:** `SliceManifest` / `JobChainRecord` / `BatchMode` names aligned across tasks.
)
