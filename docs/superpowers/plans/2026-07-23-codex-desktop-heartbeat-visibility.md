# Codex Desktop Heartbeat Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex Desktop wait for MiMoCode via native in-chat heartbeat, and demote App Server notify to a non-visibility compatibility path.

**Architecture:** Skill + docs + release contracts teach Desktop to omit `notify`, schedule a ~1m in-chat follow-up, call `mimo_status` until attention, then one `mimo_result` and delete the schedule. Existing App Server notify remains for CLI/compat history writeback only.

**Tech Stack:** TypeScript/Vitest contract tests, Markdown skill/docs, Codex plugin manifest.

---

### Task 1: Failing contract tests for Desktop heartbeat

**Files:**
- Modify: `test/unit/packaged-skill.test.ts`
- Modify: `test/unit/public-release-contract.test.ts`

- [x] **Step 1: Rewrite packaged-skill expectations**
- [x] **Step 2: Rewrite public-release-contract notify expectations**
- [x] **Step 3: Run focused tests and confirm failure** (then green after Task 2–3)

### Task 2: Update packaged skill

**Files:**
- Modify: `skills/mimocode/SKILL.md`

- [x] **Step 1: Replace "Codex notify (callback-driven)" with Desktop heartbeat primary path**
- [x] **Step 2: Add "Codex App Server notify (compat / CLI history writeback)" demotion section**
- [x] **Step 3: Update idle/acceptance sections so Desktop wakeup is heartbeat, not App Server delivered**
- [x] **Step 4: Re-run focused skill/contract tests toward green**

### Task 3: Update user docs and plugin description

**Files:**
- Modify: `README.md`
- Modify: `doc/operations-guide.md`
- Modify: `doc/compose-workflows.md`
- Modify: `.codex-plugin/plugin.json`
- Modify: `skills/build-and-install/SKILL.md`

- [x] **Step 1: Rewrite Desktop launch sequence around heartbeat**
- [x] **Step 2: Keep App Server notify docs but demote visibility claims**
- [x] **Step 3: Update plugin longDescription**
- [x] **Step 4: Re-run public-release-contract tests**

### Task 4: Clarify smoke semantics

**Files:**
- Modify: `test/smoke/local-codex-notification.test.ts`
- Modify: `doc/operations-guide.md` (smoke paragraph)
- Modify: `src/notify/types.ts` (delivered semantics comment)
- Modify: `scripts/validate-plugin.mjs` (heartbeat regression guard)

- [x] **Step 1: Rename/describe the smoke as App Server session-history writeback proof**
- [x] **Step 2: Add an explicit assertion comment that Desktop UI refresh is out of scope**

### Task 5: Full verification

- [x] **Step 1: focused contract tests**
- [x] **Step 2: `npm test`**
- [x] **Step 3: `npm run build`**
- [x] **Step 4: `npm run lint`**
- [x] **Step 5: `npm run validate:plugin`**

Do not include unrelated local refactors in `src/compose/report.ts` / `src/core/job-worker.ts` unless tests require them.
