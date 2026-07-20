# Cursor Companion Hooks Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox syntax.

**Goal:** Ship a Cursor companion that auto-continues the session when watched MiMo jobs need attention.

**Architecture:** `afterMCPExecution` records `cwd+jobId` into `~/.codex-mimo/companion-watch.json`; `stop` reads job records and emits `followup_message` until ack or loop limit.

**Tech Stack:** Node ESM (`.mjs`), Cursor `hooks.json`, Vitest for pure helpers.

## Global Constraints

- Windows-first; use `node` not bash shebangs as the hook command.
- Fail-open: hook errors print `{}` and exit 0.
- Do not require `notify` webhook/codex target for companion path.

---

### Task 1: Companion core + Cursor hooks

**Files:**
- Create: `hosts/cursor/mimo-companion.mjs`
- Create: `hosts/cursor/hooks.json`
- Create: `hosts/cursor/install.mjs`
- Create: `hosts/cursor/README.md`
- Create: `.cursor/hooks.json` (points at repo script for local trial)
- Create: `test/unit/companion/mimo-companion.test.ts`
- Create: `docs/superpowers/specs/2026-07-20-host-companion-hooks-design.md` (done)

- [x] Design doc
- [x] Implement companion script + tests
- [x] Install project hooks and verify dry-run
