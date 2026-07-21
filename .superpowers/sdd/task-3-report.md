# Task 3 Report: Request schema `idleTimeoutMs` (CLI + MCP + job definitions)

## Status

**Complete.** TDD cycle executed; Task 3 tests pass; commit on `feat/idle-timeout-observability`.

## TDD Steps

### Step 1 — Failing tests added

**`test/unit/tool-schemas.test.ts`**
- `defaults idleTimeoutMs to 30 minutes when omitted` — `JobOptionsSchema`, `PlanInput`, `ImplementInput` → `1_800_000`
- `accepts idleTimeoutMs of 0 to disable idle stop-loss`
- `rejects negative idleTimeoutMs`
- Updated shape-key assertions to include `idleTimeoutMs`

### Step 2 — Run tests (expect FAIL)

```
npm test -- tool-schemas.test.ts
```

Result: **4 failed** (field missing from schemas; `0` rejected as unrecognized key).

### Step 3 — Implementation

**`src/core/job-definitions.ts`** — `CommonRequestSchema`:
```ts
idleTimeoutMs: z.number().int().min(0).default(DEFAULT_TIMEOUT_MS),
```

**`src/codex/tool-schemas.ts`** — `JobOptionsSchema`:
```ts
idleTimeoutMs: z.number().int().min(0).default(1_800_000),
```

**`src/cli/commands.ts`**
- Added `--idle-timeout-ms` to `VALUE_FLAGS`
- `parseJobOptions` reads via `takeOptionalInteger("--idle-timeout-ms", false)` (allows `0`)

### Step 4 — Run tests (expect PASS)

```
npm run build && npm test -- tool-schemas.test.ts
```

Result: **20/20 passed**.

Full suite: **837 passed, 7 failed** — failures are downstream tests with strict `toEqual` on stored requests / compose CLI spies that omit the new default field (see Concerns).

## Commit

- `feat: accept idleTimeoutMs on work tool requests` — 4 files only

## Concerns

- **7 collateral test failures** in `cli.test.ts`, `compose-*.test.ts`, `mcp-tools/mimo-{plan,implement,review,fix-ci}.test.ts` — need `idleTimeoutMs: 1_800_000` in expectations (not in Task 3 commit scope).
- **`scripts/validate-plugin.mjs`** canonical schemas still lack `idleTimeoutMs`; `npm run validate:plugin` against live MCP will fail until a follow-up task updates the validator.
- **Task 4** still needed to wire `idleTimeoutMs` from persisted request into `runMimoCliStreaming`.

## Report path

`.superpowers/sdd/task-3-report.md`

---

## Follow-up: collateral test fallout (2026-07-21)

### Status

**Complete.** All 844 tests pass; `npm run validate:plugin` passes.

### Changes

- Updated 7 unit tests to expect default `idleTimeoutMs: 1_800_000` on stored/parsed work requests: `cli.test.ts`, `compose-background.test.ts`, `compose-cli-args.test.ts`, `mcp-tools/mimo-{plan,implement,review,fix-ci}.test.ts`.
- Added `idleTimeoutMs: { type: "integer", minimum: 0, default: 1_800_000 }` to `COMMON_JOB_PROPERTIES` in `scripts/validate-plugin.mjs` and mirrored fixture in `plugin-validator.test.ts`.

### Verification

```
npm run build && npm test && npm run validate:plugin
```

Result: **844 passed**, plugin validation passed.

### Commit

`test: expect default idleTimeoutMs in work request assertions`
