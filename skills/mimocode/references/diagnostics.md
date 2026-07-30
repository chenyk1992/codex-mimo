# Diagnostics

Read this reference only for a concrete operational question.

## Output Levels and Artifacts

- `compact` is the default for `mimo_status` and `mimo_result`; it is bounded for normal delivery.
- `standard` adds bounded operator diagnostics.
- `full` includes the complete saved result, plan, verification evidence, safe job log, and diff. Use it only for explicit manual troubleshooting.

Compact results expose reconciliation state, verified changed files, unverified candidates when detection is partial, acceptance outcomes, bounded failure causes, and `reportPath`.

Terminal compact results also include `contextOverhead`: status/result call counts, the last compact payload byte count, Codex callback attempts, standard/full usage, `needsInput`, and resume count. `statusCalls` includes heartbeat calls, but `heartbeatCalls` is `null` because caller origin is not observable. Independent relaunches are likewise reported as `relaunchCount: null`, never guessed. `tracking` distinguishes complete, partial, and unavailable historical data. The sidecar never stores tool arguments, prompts, paths, targets, secrets, or token estimates.

Reports stay on disk under `.codex-mimo/reports/`. Do not read `.result.md`, `.verification.json`, `.plan.md`, raw event JSONL, complete logs, or full diffs by default. Open only the relevant artifact section for failure diagnosis or high-risk review.

## Time Budgets

All work tools accept `timeoutMs`, `idleTimeoutMs`, `progressWarningMs`, and `progressTimeoutMs`.

- `idleTimeoutMs` defaults to 30 minutes and measures silence since the last stdout JSONL line. `0` disables it.
- `progressWarningMs` defaults to 2 minutes.
- `progressTimeoutMs` defaults to 5 minutes and measures effective progress. `0` disables this stop-loss and weakens the five-minute deliverability objective.
- `timeoutMs` is the absolute job budget.

Whichever budget fires first wins.

An idle stop finalizes as `timeout` with `idle_timeout`. A progress stop writes `.codex-mimo/reports/<jobId>.checkpoint.json` and finalizes as immutable `stalled`. Compact `mimo_result` provides a bounded reason, optional last command, and a `mimo_resume` action.

For targeted stall diagnosis, one `mimo_status` may inspect `idleMs`, `lastEventAt`, `lastProgressAt`, `quietSince`, and `processAlive`. Never poll or loop within a Desktop turn; scheduled heartbeats own revisits.

MiMo `session.post` is execution evidence, not a host wake mechanism. Desktop wakes by heartbeat, Cursor by companion hook, and App Server notify by an independent compatibility callback.
