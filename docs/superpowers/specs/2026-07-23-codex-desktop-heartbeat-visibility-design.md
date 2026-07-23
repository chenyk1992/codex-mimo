# Codex Desktop Heartbeat Visibility Design

Date: 2026-07-23
Status: approved for implementation
Primary approach: Codex Desktop uses native in-chat scheduled follow-up (heartbeat); App Server notify is a compatibility history-write path only

## Incident and root cause

Session `019f8b39-9f80-72a3-a3f0-87a08ba1a428` (job `compose-mrwgg4u6-tzeh9w`) completed MiMoCode successfully. The notification outbox marked the Codex callback `delivered`, and `read_thread` could later read the callback result from session storage. The Desktop chat surface did not refresh in real time.

The implementation conflated three distinct outcomes:

1. MiMoCode job terminal state on disk.
2. An independent App Server stdio connection receiving `turn/completed` for a callback turn.
3. The Codex Desktop renderer showing that result in the currently open chat.

App Server docs require clients to consume streaming notifications on the same connection that issued `turn/start`. The notify worker is a separate process and connection from Desktop's renderer. Therefore `delivered` proves session-history writeback on that independent connection, not Desktop UI visibility.

Existing smoke coverage only reads the persisted session rollout after the callback. Packaged skill guidance required `notify: { type: "codex", threadId }` for Desktop and forbade `heartbeat`, conflicting with Codex's documented in-chat scheduled tasks for long-running operations.

## Goals

1. Make Codex Desktop's default MiMoCode wait path use a native in-chat scheduled follow-up (minute heartbeat) that calls `mimo_status` until attention, then one `mimo_result`, then deletes the schedule and answers the user.
2. Stop teaching Desktop to pass `notify: { type: "codex" }` by default.
3. Keep the App Server notify pipeline for CLI and explicit compatibility launches, but document `delivered` as history-write completion on an independent App Server connection — never as Desktop renderer refresh.
4. Update skill, README, operations guide, Compose docs, plugin description, release-contract tests, and smoke wording so they cannot reintroduce the false equivalence.
5. Cover failure, timeout, cancel, `needs_input`, repeated revisit, and heartbeat cleanup in contract/skill tests.

## Non-goals

- Implementing a Desktop IPC bridge or shared App Server daemon with the Desktop renderer.
- Replacing Cursor companion stop-hook wakeup.
- Removing webhook or Codex App Server notify code paths.
- Guaranteeing exactly-once delivery for the compatibility App Server path.
- Blocking MCP work tools until MiMo finishes (local MCP tools time out around 60s; real jobs can take many minutes).

## Official constraints used

- Codex App Server: lifecycle notifications belong to the connection that started the turn.
- Codex scheduled tasks / automations: schedule a task inside an existing chat to check a long-running operation until it finishes, including minute-based intervals.
- Codex MCP: local MCP tool calls are not a substitute for multi-minute waits.
- Codex Hooks Stop continuation remains a fallback only; it needs extra hook trust and can block a turn for a long time.

## Selected architecture

```text
Codex Desktop (default)
  work tool (no notify) -> queued receipt + jobId
  -> create in-chat scheduled follow-up (~1 minute)
  -> each beat: mimo_status(jobId)
     still queued/running -> stop quietly
     needs_input|blocked|terminal -> mimo_result once
                                   -> delete scheduled follow-up
                                   -> final user reply

CLI / explicit compatibility
  work tool with notify:{type:codex,threadId}
  -> durable outbox -> independent App Server callback
  -> delivered = matching callback turn completed on that connection
  -> may be readable later via session storage / read_thread
  -> MUST NOT be claimed as Desktop UI refresh
```

## Truth table

| Observation | Means | Does not mean |
| --- | --- | --- |
| Work receipt `queued` | Job persisted | Desktop will auto-show a result |
| Outbox `delivered` | Independent App Server callback turn completed | Desktop renderer refreshed |
| `read_thread` sees callback text | Session storage contains the turn | User saw it live in Desktop |
| Heartbeat `mimo_result` in same chat | Desktop-owned follow-up consumed the result | App Server notify succeeded |

## Skill contract changes

Desktop section must:

1. Omit `notify` by default.
2. Require creating an in-chat scheduled follow-up / heartbeat about once per minute.
3. Restrict each beat to at most one `mimo_status` while non-terminal.
4. On attention or terminal: at most one `mimo_result`, delete the schedule, answer the user.
5. Explicitly forbid treating App Server `delivered` as Desktop visibility.
6. Keep Cursor companion and webhook guidance separate.
7. Document App Server notify as optional CLI/compat history writeback only.

## Test contract changes

- `packaged-skill.test.ts` must require Desktop heartbeat guidance and must no longer ban `heartbeat`.
- `public-release-contract.test.ts` must require the Desktop heartbeat primary path and demote `notify.threadId` to compatibility/CLI wording.
- Smoke for App Server notify must state it proves session-history writeback, not Desktop renderer refresh.
- Contract tests must mention cleanup of the scheduled follow-up after terminal/`needs_input`/`blocked`/cancel/timeout/failed.

## Compatibility

App Server notify code, preflight, outbox leasing, and prefetched-result callback prompts remain. CLI may still pass `--notify codex --thread-id`. Desktop skill and docs stop recommending that as the visibility mechanism.
