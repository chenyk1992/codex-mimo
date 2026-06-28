# Codex Wake Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Codex-facing wake adapter so a long-running MiMoCode background job can be converted into a compact heartbeat follow-up prompt without making the MCP runtime depend on Codex Desktop internals.

**Architecture:** Keep job runtime host-agnostic. Add a Codex-layer `mimo_wake` tool that builds a heartbeat-ready prompt around `mimo_wait`; compact job responses include a small wake hint pointing at that tool. Codex Desktop can then create a heartbeat automation outside the plugin process.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, MCP SDK, existing job store and signal APIs.

---

### Task 6: Codex Wake Hint API

**Files:**
- Create: `src/codex/wake.ts`
- Modify: `src/core/jobs.ts`
- Modify: `src/core/job-render.ts`
- Modify: `src/codex/tool-schemas.ts`
- Modify: `src/codex/tools.ts`
- Modify: `src/codex/mcp-server.ts`
- Test: `test/unit/codex-wake.test.ts`
- Test: `test/unit/mcp-tools/mimo-wake.test.ts`
- Test: `test/unit/job-render.test.ts`
- Test: `test/unit/tool-schemas.test.ts`
- Test: `test/unit/codex-tools.test.ts`

- [ ] **Step 1: Write failing wake hint tests**

Add tests proving `buildCodexWakeHint()` returns:
- `watch.tool === "mimo_wait"`
- `watch.arguments.cwd`, `jobId`, `sinceCursor`, `minLevel`, and `timeoutMs`
- terminal/attention signal kinds: `needs_input`, `blocked`, `completed`, `failed`, `cancelled`, `timeout`
- a compact prompt that tells Codex to call `mimo_wait`, then `mimo_result` on terminal signals.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm.cmd test -- test/unit/codex-wake.test.ts`

Expected: fail because `src/codex/wake.ts` does not exist.

- [ ] **Step 3: Implement wake hint builder**

Create `buildCodexWakeHint(job, options)` in `src/codex/wake.ts`.

- [ ] **Step 4: Add compact wake hints to job render outputs**

Add `wake?: { tool: "mimo_wake"; jobId: string; sinceCursor: number }` to active launch/status results.

- [ ] **Step 5: Add `mimo_wake` MCP tool**

Add schema and handler. The handler reads the selected job and returns `buildCodexWakeHint()`.

- [ ] **Step 6: Run Task 6 tests**

Run: `npm.cmd test -- test/unit/codex-wake.test.ts test/unit/mcp-tools/mimo-wake.test.ts test/unit/job-render.test.ts test/unit/tool-schemas.test.ts test/unit/codex-tools.test.ts`

Expected: pass.

### Task 7: Guidance, Cache Sync, And Verification

**Files:**
- Modify: `doc/operations-guide.md`
- Modify: `doc/compose-workflows.md`
- Modify: `skills/mimocode/SKILL.md`
- Installed source/cache sync: `C:\Users\Administrator\.agents\plugins\plugins\codex-mimocode`, `C:\Users\Administrator\.codex\plugins\cache\personal\codex-mimocode\0.1.0+codex.20260628034823`

- [ ] **Step 1: Update docs and skill guidance**

Document the long-task path:
1. Start with `mimo_compose background: true`.
2. Use `mimo_wake` to obtain a Codex heartbeat prompt when the user does not want an open 30-minute wait.
3. The heartbeat calls `mimo_wait` and only reads `mimo_result` after an attention or terminal signal.

- [ ] **Step 2: Run full verification**

Run: `npm.cmd test`, `npm.cmd run build`, and `git diff --check`.

- [ ] **Step 3: Sync verified build to installed plugin source/cache**

Copy verified runtime files to the local marketplace source and `0.1.0+codex.20260628034823` cache directory, then verify cached `SKILL.md` and `dist/codex/mcp-server.js` contain `mimo_wake`.
