# Codex Desktop Delivery

Read this reference only when launching or handling a Codex Desktop MiMoCode job.

Codex Desktop uses a native in-chat heartbeat. Omit `notify`; App Server callbacks are an independent compatibility path and do not guarantee Desktop UI visibility.

## Launch

1. Submit one complete work-tool request.
2. Return the stable queued receipt and `jobId`.
3. Create one scheduled in-chat heartbeat every 5 minutes. Do not shorten the cadence by default.

Every work tool returns a receipt shaped like:

```json
{
  "jobId": "...",
  "kind": "implement",
  "status": "queued",
  "actions": {
    "status": "mimo_status",
    "events": "mimo_events",
    "result": "mimo_result",
    "cancel": "mimo_cancel"
  }
}
```

## Heartbeat

On each beat, call `mimo_status` once at the default compact level:

- For `queued` or `running`, stop quietly. Do not call another control or work tool.
- For `needs_input`, `blocked`, `stalled`, `completed`, `failed`, `cancelled`, or `timeout`, call `mimo_result` once at the default compact level, then delete the heartbeat.

Repeated scheduled beats are expected. Do not add ad-hoc status checks between them. A terminal or attention outcome always stops the schedule.

Answer from compact status, changed files, build/test evidence, failure or bounded plan/review summary, risks, and `reportPath`. Request `full` only for explicit manual troubleshooting.

Plan workflows remain read-only. MiMoCode returns the plan in its final response; the bridge saves it to `.codex-mimo/reports/<jobId>.plan.md`. Normal callers consume the bounded compact summary and `reportPath`, not the full artifact. A planning run with no readable final result fails with `result_missing`.

App Server outbox `delivered`, a background callback turn, or later task history is not proof that the Desktop renderer refreshed.
