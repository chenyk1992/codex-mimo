# Codex-MiMo Unified Job Runtime Design

Date: 2026-06-23
Status: Draft for user review

## Purpose

Codex-MiMo currently exposes MiMoCode through synchronous MCP tools and Compose reports. This works well for short tasks, but long-running Compose, implementation, CI repair, and ACP-backed tasks need a more robust execution model.

The goal is to let Codex delegate substantial work to MiMoCode in a way that is observable, recoverable, cancellable, and safe to use when a task takes minutes or fails partway through.

The recommended direction is a unified Job Runtime: every long-running MiMo operation can be represented as a persisted job with a stable job ID, status, phase, logs, events, report paths, session ID, and final result.

## Success Criteria

- A caller can start a long task and immediately receive a `jobId` when background execution is requested.
- A caller can inspect active and recent jobs without reading raw files.
- A caller can retrieve the final compact result for a finished job.
- A caller can cancel an active job.
- A failed, timed-out, or cancelled job still leaves useful partial events, logs, and metadata.
- A completed or partial job can provide a MiMo session ID for follow-up work.
- Existing synchronous tool behavior remains available for short tasks.
- Compose reports remain the authoritative full artifact for Compose workflows.
- The first implementation phase does not require an ACP broker or a persistent MiMo daemon.

## Non-Goals For Phase One

- Do not build a queue scheduler with automatic retry.
- Do not make multiple long-running jobs execute concurrently by default.
- Do not replace `mimo run --format json` with ACP for all workflows.
- Do not introduce a persistent ACP broker in the first phase.
- Do not change MiMoCode's authentication, permission, or model-selection behavior.
- Do not commit, push, reset, or delete user files as part of job management.

## Recommended Approach

Implement a unified Job Runtime in phases.

Phase one should support background Compose jobs first, then generalize the same runtime to `mimo_implement`, `mimo_review`, `mimo_fix_ci`, and resume flows. The first backend should be the existing CLI JSONL path because it is already used by `runComposeWorkflow()` and has report generation, event parsing, diff capture, and verification support.

ACP integration should come after the job model is stable. ACP can then plug into the same job sink by streaming `session/update` events into the job event log.

## Architecture

```text
Codex MCP tools
  -> Tool handlers
    -> Job Runtime
      -> CLI runner or ACP runner
        -> event sink
        -> report writer
        -> job store
```

The Job Runtime owns lifecycle state. The CLI runner and ACP runner only execute work and emit progress events.

## Components

### Job Store

Add a persisted job store under `.codex-mimo/jobs`.

Suggested layout:

```text
.codex-mimo/
  jobs/
    state.json
    <job-id>.json
    <job-id>.log
    <job-id>.events.jsonl
  reports/
  events/
  diffs/
  sessions.json
```

`state.json` should contain a compact list of recent jobs for status views. Per-job JSON files should contain the full request, result metadata, paths, and error state.

Keep report, event, and diff files already produced by Compose. The job file should link to them instead of duplicating large content.

### Job Record

Use one shared job shape for all tool kinds:

```ts
type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

type JobPhase =
  | "queued"
  | "starting"
  | "planning"
  | "investigating"
  | "editing"
  | "verifying"
  | "reviewing"
  | "finalizing"
  | "done"
  | "failed"
  | "cancelled";

interface JobRecord {
  id: string;
  kind: "plan" | "implement" | "review" | "fix-ci" | "compose" | "resume" | "acp";
  workflow?: string;
  cwd: string;
  task: string;
  request: unknown;
  status: JobStatus;
  phase: JobPhase;
  pid?: number | null;
  sessionId?: string | null;
  parentJobId?: string | null;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  summary?: string;
  changedFiles: string[];
  verification: Array<{
    command: string;
    exitCode: number | null;
    passed: boolean;
    durationMs?: number;
  }>;
  reportPaths?: {
    json?: string;
    markdown?: string;
    eventsJsonl?: string;
    diff?: string;
  };
  logFile: string;
  eventsFile: string;
  error?: string;
}
```

The state file should keep only the fields needed for fast status display. The per-job file should keep the full record.

### Job Runtime API

Add internal APIs with small responsibilities:

```ts
createJob(input): JobRecord
markRunning(jobId, patch): void
appendJobEvent(jobId, event): void
appendJobLog(jobId, line): void
completeJob(jobId, result): void
failJob(jobId, error): void
cancelJob(jobId): Promise<void>
listJobs(cwd, options): JobRecord[]
readJob(cwd, jobId): JobRecord
```

Tool handlers should not manually edit job files. They should call the runtime API.

### Streaming CLI Runner

The existing `defaultRunMimo()` waits for `execa()` to finish and then parses all stdout. For long tasks, add a streaming runner that reads stdout line by line.

Each line should be:

1. appended to `<job-id>.events.jsonl`;
2. normalized through `normalizeMimoEvent()`;
3. used to update job phase, summary, changed files, commands, and usage;
4. retained in report generation input.

On process exit, build the same Compose report currently produced by `runComposeWorkflow()`.

This should preserve the current report contract while making partial output available during execution.

### Phase Inference

Map normalized events to phases conservatively:

```text
message                -> investigating
tool bash/test/lint    -> verifying
tool bash/other        -> investigating
tool edit/write/diff   -> editing
workflow review        -> reviewing
verification runner    -> verifying
final report write     -> finalizing
success                -> done
error                  -> failed
cancel                 -> cancelled
```

The phase is only a user-facing hint. It should never control correctness.

### Result Handling

The runtime should distinguish three result levels.

Progress result:

```text
jobId
kind
status
phase
elapsed
summary
sessionId
changedFiles
recent progress lines
actions
```

Compact result:

```text
jobId
status
summary
sessionId
changedFiles
verification
error
reportPaths
resumeHint
```

Full artifact result:

```text
job JSON
Compose report JSON
Compose report Markdown
events JSONL
diff file
job log
```

MCP tools should return compact results by default and include paths to full artifacts.

### New MCP Tools

Add job-management tools:

```text
mimo_status
mimo_result
mimo_cancel
mimo_jobs
```

Suggested behavior:

- `mimo_status({ cwd, jobId? })`: show one job or active/recent jobs for the workspace.
- `mimo_result({ cwd, jobId? })`: return the final compact result for a finished job, defaulting to the latest finished job for the workspace.
- `mimo_cancel({ cwd, jobId })`: cancel an active job.
- `mimo_jobs({ cwd, all? })`: list recent job records.

Existing tools should gain optional background controls where useful:

```ts
background?: boolean;
wait?: boolean;
```

For phase one, add this first to `mimo_compose`.

### Background Execution

When `background: true` is passed:

1. validate the request;
2. create a queued job;
3. persist the full request in the job file;
4. spawn a detached worker process;
5. return immediately with `jobId`, status, and follow-up tool hints.

The worker should read the persisted request and run the same workflow code as the foreground path. This prevents argument drift between foreground and background execution.

On Windows, process creation and cancellation must avoid shell-composed destructive commands. Use Node process APIs and targeted process termination.

### Cancellation

Cancellation should be best-effort in phase one.

For CLI jobs:

1. mark cancellation requested;
2. terminate the worker process tree;
3. mark job `cancelled`;
4. preserve log, events, and any partial report paths.

For future ACP jobs:

1. attempt protocol-level cancel if available;
2. fall back to process termination;
3. record which cancellation method was used.

### Resume By Job

Add resume support after background Compose is stable.

Suggested API:

```text
mimo_resume_job({ cwd, jobId, task })
```

The handler should:

1. read the job;
2. require a `sessionId`;
3. create a new continuation job with `parentJobId`;
4. pass the old session ID to MiMoCode;
5. run the delta task;
6. persist the new result separately.

Do not mutate the old job into the resumed result. Keeping a parent-child chain is more auditable and easier to debug.

### Session Store Changes

Extend the existing `SessionStore` instead of replacing it.

Add optional fields:

```ts
jobId?: string;
parentJobId?: string;
status?: JobStatus;
reportPaths?: Record<string, string>;
summary?: string;
```

The session store remains an index of MiMo sessions. The job store becomes the source of truth for execution lifecycle.

### Compose Runner Changes

Keep `runComposeWorkflow()` as the synchronous public function initially, but extract lower-level pieces:

```text
buildComposeRunSpec()
runMimoCliStreaming()
buildComposeReport()
writeComposeReport()
```

The worker path and foreground path should share the report-building code.

`buildReport()` should accept events collected from either completed stdout or streaming event files.

### ACP Integration Later

ACP already has `AcpBridge` with in-memory events and audit logging. After the job runtime exists, update it to accept a job event sink:

```ts
new AcpBridge({
  cwd,
  policy,
  logDir,
  onEvent,
  onPhase,
  onSession
})
```

This lets ACP jobs write the same job log and event file as CLI jobs.

Do not introduce a persistent ACP broker until:

- background CLI jobs are stable;
- job status/result/cancel are working;
- ACP events are persisted through the same sink;
- tests cover process cleanup and partial result recovery.

## Tool Response Contracts

Background launch response:

```json
{
  "jobId": "job-...",
  "status": "queued",
  "phase": "queued",
  "summary": "Started codex-mimo compose dev.",
  "actions": {
    "status": "mimo_status",
    "result": "mimo_result",
    "cancel": "mimo_cancel"
  }
}
```

Status response:

```json
{
  "jobId": "job-...",
  "status": "running",
  "phase": "verifying",
  "elapsedMs": 124000,
  "sessionId": "sess_...",
  "summary": "Running verification.",
  "changedFiles": ["src/example.ts"],
  "progress": ["Running npm test", "2/3 verification commands passed"]
}
```

Result response:

```json
{
  "jobId": "job-...",
  "status": "completed",
  "summary": "dev passed; 3 changed files; 2/2 verification commands passed.",
  "sessionId": "sess_...",
  "changedFiles": ["src/a.ts", "test/a.test.ts"],
  "verification": [],
  "reportPaths": {
    "json": ".codex-mimo/reports/...",
    "markdown": ".codex-mimo/reports/...",
    "eventsJsonl": ".codex-mimo/events/..."
  },
  "resumeHint": {
    "tool": "mimo_resume_job",
    "jobId": "job-..."
  }
}
```

## Error Handling

Classify failures explicitly:

- `mimo_unavailable`
- `startup_failed`
- `timeout`
- `nonzero_exit`
- `malformed_jsonl`
- `semantic_failure`
- `verification_failed`
- `policy_denied`
- `cancelled`
- `report_write_failed`

Every failed job should include:

```text
error code
human-readable message
stderr excerpt when available
events/log/report paths when available
resume possibility
```

## Verification Strategy

Unit tests:

- job store creates, updates, lists, prunes, and reads jobs;
- job IDs are unique and stable;
- streaming JSONL parser appends valid and raw events;
- phase inference is deterministic;
- background launch persists request and returns a job ID;
- result lookup returns compact final result;
- cancel marks active job cancelled;
- failed jobs preserve partial events;
- resume-by-job rejects jobs without session IDs;
- read-only workflows still detect write violations.

Integration-style tests with fake MiMo:

- background Compose completes and writes job, report, events, and diff paths;
- timeout preserves partial events and marks failure;
- cancellation terminates the worker and preserves partial logs;
- malformed JSONL does not crash the worker;
- verification failure marks job failed and keeps report paths.

Manual checks:

```bash
npm run build
npm test
```

## Implementation Phases

### Phase 1: Job Store And Background Compose

- Add job store and job record types.
- Add streaming CLI runner for `mimo run --format json`.
- Add background mode to `mimo_compose`.
- Add `mimo_status`, `mimo_result`, `mimo_cancel`, and `mimo_jobs`.
- Preserve current synchronous `mimo_compose` behavior.
- Write reports for completed, failed, timed-out, and cancelled Compose jobs.

### Phase 2: Generalize To More Tools

- Add background support to `mimo_implement` and `mimo_fix_ci`.
- Add compact job result rendering for non-Compose tools.
- Persist session IDs from all tools into the session store with job linkage.
- Add `mimo_resume_job`.

### Phase 3: ACP Event Sink

- Add job event sink support to `AcpBridge`.
- Persist ACP `session/update` events through job files.
- Map ACP terminal/file updates to job phases and changed files.
- Keep ACP execution foreground until cancellation and partial-result behavior is tested.

### Phase 4: Optional ACP Broker

- Evaluate whether MiMo ACP startup cost justifies a persistent broker.
- If justified, build a single-active-stream broker similar in spirit to codex-plugin-cc.
- Support protocol-level interrupt before process termination.

## Open Decisions

These are intentionally resolved for phase one:

- Default execution remains synchronous unless `background: true` is passed.
- Background execution is first implemented for `mimo_compose`.
- The first worker backend is CLI JSONL, not ACP.
- Old jobs are retained with a bounded retention policy; exact retention count can default to 50, matching codex-plugin-cc's practical pattern.
- Resume creates a new child job instead of mutating the original job.

## Risks And Mitigations

Risk: background workers leave orphaned processes.
Mitigation: store worker PID, implement best-effort process tree termination, and mark stale jobs on status reads.

Risk: event logs grow too large.
Mitigation: return compact summaries through MCP and keep full logs on disk.

Risk: reports and jobs diverge.
Mitigation: make the job record link to report paths and keep report generation in one shared code path.

Risk: cancellation loses useful context.
Mitigation: append events and logs continuously before final report generation.

Risk: ACP and CLI produce different event shapes.
Mitigation: normalize both into the existing `NormalizedMimoEvent` model, adding fields only when needed.

## Review Checklist

- The first phase is scoped to job runtime, streaming CLI events, background Compose, and job management tools.
- Existing synchronous behavior remains intact.
- The design preserves existing Compose report artifacts.
- Recovery is based on stored jobs and session IDs.
- ACP broker work is deliberately postponed.
- Failure and cancellation still produce inspectable artifacts.
