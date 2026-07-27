# Codex-MiMo compact delivery, stall recovery, and sliced development design

Date: 2026-07-26  
Status: approved for phased implementation planning  
Primary approach: compact-by-default result artifacts, effective-progress stop-loss, checkpoint-based continuation, host-gated development acceptance, and a durable sequential slice chain

## Problem

Codex-MiMo already returns queued receipts, persists jobs, runs work in a shared worker, exposes compact public summaries, and gates Compose completion on any configured verification command. Those mechanisms prevent a foreground MCP call from carrying an entire MiMoCode run.

Four remaining boundaries still consume excessive Codex context or weaken deliverability:

1. `mimo_result` and the prefetched Codex callback can include the unbounded final MiMoCode text in `output`. A long plan, review, or implementation narrative therefore enters the main Codex context even when the caller only needs the outcome.
2. Runtime stop-loss measures time since the last JSONL line, not time since effective progress. Its default is 30 minutes, so a live but unproductive process can delay attention for too long, while repeated non-progress text can keep a job looking active.
3. `mimo_resume` accepts only `needs_input` and `blocked`. A timed-out or stalled job cannot continue its MiMo session and must usually be relaunched as a cold task.
4. A Compose `dev` job can finish with an empty detected verification set. Verification commands are not classified into build, targeted tests, and final diff review, so the host cannot prove those gates ran in the required order.

Large write objectives also remain a single job. Skill text recommends narrow slices, but the bridge has no durable representation of dependent slices and cannot advance them one at a time.

## Goals

1. Make `mimo_result` compact by default. A successful implementation result should normally consume no more than about 1,000–2,000 Codex tokens.
2. Save complete plans, final model text, verification details, logs, and diffs as artifacts. Return their paths instead of their contents unless detail is explicitly requested.
3. Detect no effective progress within five minutes by default, persist enough context to continue safely, terminate the stuck process tree, and produce one attention outcome.
4. Return the last safe command display, a classified stall reason, and a directly usable `mimo_resume` instruction for stalled jobs.
5. Allow `mimo_resume` to continue `stalled` and `timeout` jobs without repeating broad repository discovery or already completed work.
6. Require every `dev` slice to pass build, targeted tests, and final diff self-check in that order before it can be marked completed.
7. Automatically turn a broad write objective into a bounded dependency manifest and execute one slice at a time.
8. Keep polling overhead near zero: no running logs or repeated progress text enter the main session, and the default heartbeat response is a single short state.
9. Preserve the current durable supervisor, process ownership, atomic job transition, session callback, and notification-outbox guarantees.

## Non-goals

- Building a general-purpose parallel DAG scheduler.
- Rolling back workspace changes from earlier successful slices when a later slice fails.
- Hiding full diagnostics from an operator who explicitly requests `full`.
- Treating model reasoning text, CPU use, or a live process alone as proof of progress.
- Replacing the existing absolute `timeoutMs` or transport-level `idleTimeoutMs`.
- Replaying a verification result when its command inputs or relevant files changed.
- Guaranteeing continuation when both the MiMo session and the persisted checkpoint are unavailable.
- Returning raw secrets, environment variables, webhook configuration, or unredacted command credentials at any output level.

## Existing behavior retained

- Work entry tools return a queued receipt and do not wait for completion.
- The workspace supervisor owns one physical-workspace lock and replaces crashed workers while durable work remains.
- `session.post` remains required evidence for a successful MiMo invocation.
- Job transitions and attention outbox records remain durable and atomic.
- `timeoutMs` remains the absolute wall-clock run budget.
- `idleTimeoutMs` remains the transport-silence stop-loss and defaults to 30 minutes.
- Read-only workflows continue to compare Git status, content fingerprints, and HEAD before and after execution.
- Verification commands continue to execute without a shell.

## Considered approaches

### Minimal output and timeout patch

Add an output-level parameter, reduce idle timeout to five minutes, and permit timeout resume.

This is small, but it conflates JSONL activity with useful progress, cannot prove the ordered development gates, and still leaves large objectives as one fragile run.

### Layered runtime with a durable sequential slice chain

Separate public result rendering from artifacts, track effective progress, persist continuation checkpoints, introduce an ordered acceptance runner, and represent a broad write task as a bounded slice manifest. Execute ready slices sequentially under the existing workspace lock.

This is the selected approach. It satisfies the delivery and token goals without introducing concurrent workspace writers or a general scheduler.

### General DAG orchestration

Add parallel dependencies, resource locks, retries, rollback, and cross-workspace scheduling.

This is deferred. The requested workflow is intentionally sequential, and a generalized scheduler would add substantial recovery and consistency surface without improving the stated acceptance criteria.

## Selected architecture

```text
work tool
  -> root job receipt
  -> bounded planning/decomposition when batchMode != single
  -> durable slice manifest
  -> next dependency-ready slice
       -> focused MiMo implementation invocation
       -> host build gate
       -> host targeted-test gate
       -> deterministic diff checks
       -> read-only MiMo diff review
       -> slice completed
  -> next slice
  -> root finalization
       -> compact delivery record
       -> complete artifacts on disk
       -> one terminal/attention notification

during each MiMo invocation
  any JSONL/activity -> lastActivityAt
  effective change  -> lastProgressAt + atomic checkpoint
  no progress 2m    -> internal quiet probe
  no progress 5m    -> terminate tree -> stalled -> compact attention result
```

The root job is the public unit. Planner, implementation slice, and diff-review jobs are internal children. Internal children do not inherit the external notification target. Only the root job creates a Codex or webhook delivery.

## Output levels

### Input contract

`mimo_result` accepts:

```ts
interface JobResultInput {
  cwd: string;
  jobId?: string;
  level?: "compact" | "standard" | "full";
}
```

`level` defaults to `compact`.

`mimo_status` accepts the same level names. Its default compact representation is the heartbeat form described later. The CLI may explicitly request `standard` for an operator-oriented display; the MCP default remains compact.

### Compact implementation result

The compact implementation payload has only these unconditional fields:

```ts
interface CompactJobResult {
  status: JobStatus;
  changedFiles: string[];
  tests: CompactAcceptanceResult[];
  failure: CompactFailure | null;
  reportPath: string | null;
  attention?: CompactAttention;
}
```

`attention` is present only for `needs_input`, `blocked`, `stalled`, resumable `timeout`, or a resumable acceptance failure.

```ts
interface CompactAcceptanceResult {
  stage: "build" | "test" | "diff_check";
  command: string;
  outcome: "passed" | "failed" | "not_applicable";
}

interface CompactFailure {
  code: string;
  reason: string;
  failedStage?: "build" | "test" | "diff_check";
  failedCommand?: string;
  failedTests?: string[];
  suggestion?: string;
}

interface CompactAttention {
  kind: "needs_input" | "blocked" | "stalled" | "timeout" | "resumable_failure";
  reason: string;
  lastCommand?: string;
  resume?: {
    tool: "mimo_resume";
    jobId: string;
  };
}
```

The payload does not contain `output`, session IDs, event lists, logs, diffs, notification attempts, execution-callback details, or generic actions.

### Compact planning and review result

Planning and review jobs need a useful semantic result even though they normally have no changed files or tests. They use the same compact payload and may add one conditional field:

```ts
summary?: string;
```

The summary is capped at 500 characters and is included only for read-only semantic deliverables such as plans and reviews. The complete plan or review is stored at the report artifact path.

### Compact size budget

The UTF-8 encoded JSON payload must not exceed 6,000 bytes.

Reduction order:

1. Remove optional success summary.
2. Limit failed test names.
3. Replace a long changed-file list with a bounded prefix and a final `"<N more; see report>"` entry.
4. Replace a long acceptance list with the first result for each stage.
5. Shorten failure evidence while preserving code, reason, first failed command, suggestion, report path, and resume instruction.

Mandatory failure and continuation information must never be silently removed. A representative English and Chinese fixture suite will assert the byte budget and approximate the 1,000–2,000-token target.

### Standard result

`standard` contains the compact result plus:

- job and parent identity;
- a bounded outcome summary;
- phase and elapsed duration;
- completed and remaining slice counts;
- the first key compiler/test/review error excerpt;
- the incomplete checklist;
- report artifact paths.

Standard results do not contain complete logs, event streams, plans, or diffs. Key excerpts remain bounded and sanitized.

### Full result

`full` is explicit operator diagnostics and contains:

- complete final MiMoCode text;
- complete plan or review text;
- all verification stdout and stderr;
- job log;
- full diff;
- slice manifest and checkpoints;
- existing structural job and notification details.

Secrets remain redacted. Full content is not semantically truncated. If an MCP transport hard limit prevents one response, the tool returns a clear `artifact_too_large` entry with the exact artifact path instead of silently truncating or falling back to compact.

### Callback payload

Automatic Codex callbacks always use compact rendering, independent of any previous interactive `mimo_result` level. The callback prompt receives no full final text, plan, log, or diff.

This supersedes the `output` retention in the public callback envelope described by the 2026-07-23 prefetched-result callback design. Prefetching remains, but the prefetched value is the compact delivery record.

## Unified delivery artifacts

Every terminal or attention job writes a structural report. Model output is never required to remain only inside raw events.

```text
.codex-mimo/reports/<jobId>.json
.codex-mimo/reports/<jobId>.md
.codex-mimo/reports/<jobId>.result.md
.codex-mimo/reports/<jobId>.plan.md
.codex-mimo/reports/<jobId>.verification.json
.codex-mimo/reports/<jobId>.checkpoint.json
.codex-mimo/reports/<jobId>.slices.json
.codex-mimo/events/<jobId>.jsonl
.codex-mimo/diffs/<jobId>.diff
```

Only applicable artifacts are created. `JobReportPaths` gains optional `result`, `plan`, `verification`, `checkpoint`, and `slices` fields.

The host creates a normalized delivery record from authoritative evidence:

- outcome and error code from the job classifier;
- changed files from Git evidence;
- acceptance results from host command execution;
- session and callback state from the worker;
- complete final text from normalized events;
- bounded plan/review summary from a deterministic extractor.

No additional model call is used to summarize output. The extractor prefers an explicit final summary section and otherwise uses the first substantive sentence or bounded bullet set. It never copies tool arguments or raw event payloads.

This supersedes the current plan contract that requires callers to consume `mimo_result.output`. A plan job writes the full plan to `<jobId>.plan.md`; compact callers consume only its bounded summary and path.

## Effective progress model

### Separate clocks

Each running invocation records:

```ts
lastActivityAt?: string;
lastProgressAt?: string;
lastProgressKind?: EffectiveProgressKind;
lastProgressFingerprint?: string;
lastTool?: string;
lastCommand?: string;
progressWarningMs: number;
progressTimeoutMs: number;
```

`lastActivityAt` advances for any consumed MiMo JSONL line or relevant process I/O.

`lastProgressAt` advances only when normalized evidence indicates a new useful state:

- a new, non-duplicate tool operation starts;
- a tool operation completes or changes exit state;
- a file write/edit/diff changes a content fingerprint;
- a new verification stage or command starts or completes;
- workflow phase advances;
- a slice or checklist item completes;
- `session.post` supplies new terminal evidence.

Reasoning and text events do not independently count as progress. A repeated event with the same progress fingerprint does not refresh the progress clock.

The fingerprint uses only safe normalized data, such as event kind, tool kind, sanitized path or command identity, exit state, and changed-file hash. It does not persist raw prompt or tool payload content.

### Defaults

```text
progressWarningMs = 120000   # 2 minutes
progressTimeoutMs = 300000   # 5 minutes
idleTimeoutMs     = 1800000  # existing 30-minute transport silence
timeoutMs         = 1800000  # existing default absolute run budget
```

`progressTimeoutMs: 0` disables effective-progress stop-loss for an explicitly exceptional task. Documentation must warn that disabling it weakens the five-minute deliverability objective.

### Two-stage behavior

At `progressWarningMs`:

- set an internal `quietSince` observation;
- probe the recorded process identity;
- classify the likely stall reason;
- do not transition the job;
- do not notify Codex;
- do not add repeated public progress text.

At `progressTimeoutMs`:

1. Re-read the durable record to avoid racing a recent progress update.
2. Persist a final atomic checkpoint.
3. Request termination of the owned MiMo process tree.
4. Confirm process termination using existing process identity safeguards.
5. Transition the invocation and public root job to `stalled`.
6. Emit one attention signal and, when configured, one root notification delivery.

If process termination cannot be confirmed, the job becomes `blocked` with `stalled_process_alive`, and resume is withheld until ownership is resolved. The bridge must never launch a continuation concurrently with a possibly live writer.

### Stall reasons

The public error code is one of:

- `command_silent`: the latest observed operation is an unfinished command;
- `agent_silent`: process is alive but no new event or operation is visible;
- `no_effective_progress`: activity continues without a new progress fingerprint;
- `worker_lost`: process identity is absent or dead while the job remains running;
- `verification_silent`: a host verification command exceeded its progress lease;
- `stalled_process_alive`: stop-loss could not confirm process-tree termination.

The compact reason is fixed and sanitized. Full diagnostics retain timestamps and safe process evidence.

## Job status and heartbeat

Add `stalled` to `JobStatus`.

```text
queued -> running | failed | cancelled
running -> needs_input | blocked | stalled | completed | failed | cancelled | timeout
```

`stalled` is immutable like the existing paused and terminal records. Continuing it creates a child continuation job rather than mutating historical execution evidence back to running.

`stalled` is an attention signal kind and is included in `mimo_wait`, companion wakeup, scheduled heartbeat cleanup, and notification dispatch.

Default `mimo_status` output:

```json
{"status":"queued"}
{"status":"running"}
{"status":"stalled","resultAvailable":true}
{"status":"completed","resultAvailable":true}
```

It contains no progress array, repeated summary, changed-file list, timestamps, tools, or notification details.

`mimo_status level=standard` exposes the current diagnostic fields plus `lastProgressAt`, `progressIdleMs`, `lastCommand`, effective timeout, current slice, and completed-slice count. `full` may include the bounded recent signal page but still does not inline raw JSONL.

Running child milestones never create a Codex callback. The root task notifies only on `completed`, `failed`, `cancelled`, `timeout`, `stalled`, `needs_input`, or `blocked`.

## Durable continuation checkpoint

### Checkpoint contents

The worker atomically rewrites `<jobId>.checkpoint.json` after effective progress and before every attention or terminal transition:

```ts
interface JobCheckpoint {
  version: 1;
  jobId: string;
  chainId: string;
  objective: string;
  workflow?: string;
  sliceId?: string;
  sessionId?: string | null;
  repositoryFingerprint: string;
  contextFiles: string[];
  changedFiles: string[];
  completedSlices: string[];
  completedChecklist: string[];
  remainingChecklist: string[];
  acceptance: AcceptanceSnapshot;
  lastProgressAt?: string;
  lastProgressKind?: string;
  lastCommand?: string;
  artifactPaths: JobReportPaths;
}
```

The repository fingerprint covers HEAD plus fingerprints for files relevant to the chain. It does not require hashing the entire repository on every event.

Context-file and checklist data come from the validated slice manifest when available. For a legacy single job without a manifest, the host derives context files from observed read/write paths and changed files. If exact remaining work is unavailable, the checkpoint says so rather than inventing completion.

### Resume eligibility

`mimo_resume` accepts:

- `needs_input`;
- `blocked` when its external condition is declared resolved; the caller must provide a non-empty
  `task` describing that resolution;
- `stalled`;
- `timeout`;
- `failed` only for an allowlisted resumable code such as `build_failed`, `tests_failed`, or `diff_check_failed`.

Cancellation, semantic task rejection, read-only violation, and an unresolved live process are not automatically resumable.

### Resume input

```ts
interface ResumeInput {
  cwd: string;
  jobId: string;
  task?: string;
  model?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  progressTimeoutMs?: number;
}
```

`task` becomes an optional correction or additional instruction. Omitting it means “continue the first incomplete checkpoint item.”

### Continuation strategy

1. Verify no owned process from the parent remains alive.
2. Verify the checkpoint version and repository fingerprint.
3. If the parent has a session ID, invoke `mimo run --session <id>` with the focused continuation prompt.
4. If no session ID exists, start a new session with a prompt-transport file containing only the objective, checkpoint, relevant paths, completed work, failed command evidence, and remaining checklist.
5. Explicitly forbid broad project scanning, repetition of completed slices, and rerunning still-valid passed gates.
6. Create a continuation child with the same stable `chainId`.

If relevant files changed after the checkpoint, return `resume_conflict` with those paths. The bridge must not silently resume against stale assumptions.

A chain index records the latest continuation job. Concurrent resume attempts use the existing process-lock mechanism so only one child can be created.

## Development acceptance pipeline

### Request contract

Write workflows accept:

```ts
interface DevelopmentAcceptanceInput {
  build?: string[];
  test?: string[];
  diffCheck?: boolean;
}
```

`mimo_compose workflow=dev`, `execute-plan`, and automatic implementation slices normalize this into a required host acceptance plan.

Legacy `verification[]` remains accepted during migration and maps to the test stage. It does not by itself satisfy the build stage.

### Command discovery

The planning/decomposition phase proposes focused commands. The host validates that every command is executable without a shell.

Build detection uses project-specific evidence, for example a package build script, TypeScript configuration, Cargo, Go, Maven, Gradle, or an explicit caller command. A recognized non-compiled project may produce a host-validated `not_applicable` build result with a fixed reason. The model cannot skip build by returning an arbitrary explanation.

Targeted tests must be non-empty for a completed write slice. A broad default such as an entire repository test suite is allowed only when no narrower target exists and the manifest records that reason.

If the host cannot establish a valid build disposition or a target test command before editing begins, the root pauses as `needs_input` with `acceptance_config_missing`; it does not perform unverified development.

### Ordered stages

Each write slice executes:

```text
focused implementation
  -> build commands
  -> targeted test commands
  -> deterministic diff checks
  -> read-only MiMo diff review
  -> slice completed
```

The runner is fail-fast between stages. A failed build prevents tests and review. A failed target test prevents diff review.

Verification signals `verification_started` and `verification_finished` are emitted for each host stage and persisted for diagnostics, but they do not notify the main Codex session.

### Diff self-check

The final diff gate contains:

1. `git diff --check`.
2. Changed-file scope comparison against slice `allowedPaths`.
3. HEAD and commit checks to reject unexpected commits.
4. Conflict-marker and accidental generated-artifact checks.
5. A read-only MiMo review using the same session and the saved diff path.
6. A second Git snapshot proving the review did not write files.

The review final text contains a strict, validated verdict envelope:

```json
{
  "verdict": "pass",
  "findings": []
}
```

Malformed or missing verdict evidence fails with `delivery_contract_missing`. Blocker or major correctness, regression, security, or missing-test findings fail with `diff_check_failed`. Lower-severity findings remain report warnings.

### Completion predicate

A development slice is completed only when all are true:

```text
implementation MiMo process exited successfully
session.post outcome is completed
build stage is passed or host-validated not_applicable
at least one target test command passed
all target test commands passed
all deterministic diff checks passed
read-only review verdict passed
review produced no workspace changes
```

A root development job is completed only when every slice is completed.

The prior Compose `needs_review` report state cannot coexist with a completed `dev` job under this contract. `needs_review` may remain for workflows that do not promise development acceptance.

### Failure summary and shortest fix

The report retains complete stdout and stderr. Compact failure rendering extracts:

- the first failed stage;
- the first failed command;
- bounded failed test names when a framework adapter recognizes them;
- the first source file and line when recognizable;
- one deterministic shortest-next-step suggestion.

Examples:

- `Fix the first TypeScript error at src/a.ts:42, then rerun npm run build.`
- `Fix payment callback test "rejects invalid signature", then rerun npm test -- payment-callback.test.ts.`
- `Remove out-of-scope change README.md, then rerun the diff check.`

Framework adapters may recognize Vitest/Jest, pytest, Cargo, and Go output. Unknown output falls back to “Fix the first error in the report, then rerun `<command>`.” No extra model call is required.

## Small-batch planning and execution

### Batch mode

Write entries accept:

```ts
batchMode?: "auto" | "single" | "sliced";
```

- `auto` is the default. A bounded read-only planning pass returns one or more slices.
- `single` asserts that the caller already supplied one narrow deliverable.
- `sliced` requires at least two slices and fails planning if the objective cannot be decomposed safely.

`auto` returning one slice incurs no additional chain behavior beyond the acceptance stages.

### Slice manifest

```ts
interface SliceManifest {
  version: 1;
  chainId: string;
  objective: string;
  repositoryFingerprint: string;
  slices: SliceDefinition[];
}

interface SliceDefinition {
  id: string;
  title: string;
  objective: string;
  dependsOn: string[];
  contextFiles: string[];
  allowedPaths: string[];
  acceptance: DevelopmentAcceptanceInput;
}
```

`contextFiles` and `allowedPaths` are repository-relative. `allowedPaths` may contain validated glob
patterns; it is not an unrestricted model-generated filesystem allowlist.

Validation rules:

- one to eight slices;
- unique stable IDs;
- acyclic dependencies;
- one explicit deliverable per slice;
- each slice has bounded allowed paths;
- each slice has a valid build disposition and at least one targeted test;
- every dependency refers to a manifest slice;
- no slice may broaden the root objective;
- the manifest itself is saved before write work begins.

The planner must prefer examples such as “only add the schema,” “only implement the callback,” and “only add the focused tests,” rather than grouping an entire feature into one slice.

### Durable chain

A chain record under `.codex-mimo/jobs/` stores:

```ts
interface JobChainRecord {
  version: 1;
  chainId: string;
  rootJobId: string;
  latestContinuationJobId?: string;
  manifestPath: string;
  sliceStates: Record<
    string,
    "pending" | "running" | "completed" | "failed" | "stalled" |
    "needs_input" | "blocked" | "cancelled" | "timeout"
  >;
  currentSliceId?: string;
  completedSliceIds: string[];
}
```

The root remains the public job. Internal children use a distinct internal slice job definition and `parentJobId`/`chainId`.

The supervisor selects one dependency-ready slice in manifest order. It never runs two write slices concurrently in the same workspace, even when the dependency graph would permit it.

After a slice completes:

1. Persist its checkpoint, artifacts, changed files, and acceptance results.
2. Atomically mark the slice completed in the chain record.
3. Refresh the root's aggregate progress.
4. Start the next dependency-ready slice without notifying Codex.

If a slice fails, stalls, blocks, or needs input, later slices stay pending and the root transitions to the corresponding attention state. Earlier successful workspace changes remain and are listed as completed work.

### Crash recovery and idempotency

The supervisor treats unfinished chain records as durable work.

- A lease identifies the active child.
- Recovery verifies child process identity before relaunch.
- A completed slice is never relaunched.
- A running slice with a confirmed live process is reattached or left owned.
- A running slice without a live process becomes stalled or failed with durable evidence.
- Root aggregation is recomputable from child records and the manifest.

This extends the existing worker replacement model rather than creating an independent scheduler daemon.

## Polling and notification contract

Recommended Codex Desktop flow:

```text
launch work -> queued receipt
schedule five-minute in-chat heartbeat
heartbeat -> mimo_status compact
running/queued -> no user message
attention/terminal -> mimo_result compact once
                  -> delete heartbeat
                  -> answer user
```

The runtime progress timeout is independent of the five-minute UI heartbeat. A job can become stalled and enqueue an explicit notification before or at the next scheduled check.

Rules:

- No running log text is included in status, callbacks, or scheduled heartbeat messages.
- No child-slice completion callback is sent.
- `mimo_events` remains an explicit diagnostic tool and defaults to warning/attention signals.
- `mimo_wait` remains available for host-controlled waiting but returns only the attention status and result availability by default.
- Webhook and compatibility App Server deliveries use the same compact root result.
- An operator must explicitly request `standard` or `full`.

## Failure codes

Add stable public codes:

```text
no_effective_progress
command_silent
agent_silent
worker_lost
verification_silent
stalled_process_alive
acceptance_config_missing
build_failed
tests_failed
diff_check_failed
delivery_contract_missing
resume_context_missing
resume_conflict
slice_plan_invalid
slice_failed
artifact_too_large
```

Existing codes such as `idle_timeout`, `timeout`, `verification_failed`, `read_only_violation`, and callback errors remain readable for old records.

## Security and privacy

- Compact and standard output never includes raw prompts, raw event payloads, stdout, stderr, or full commands with credentials.
- `lastCommand` is a safe display string, length-bounded and redacted for known secret flags, URLs, headers, and environment assignments.
- Full output remains redacted for secrets even though semantic diagnostics are complete.
- Checkpoints store relevant paths and normalized state, not environment variables or webhook targets.
- Notification targets and thread IDs remain outside report artifacts.
- Callback result content is untrusted data and remains explicitly delimited in the Codex prompt.
- Resume prompt files use the existing UTF-8 transport and contain only allowlisted checkpoint fields.

## Compatibility and migration

1. Old job records load with `lastActivityAt = lastEventAt` and no `lastProgressAt`; progress tracking begins when a new worker or continuation observes them.
2. Old terminal records remain readable through all result levels.
3. Existing `verification[]` inputs are accepted temporarily and mapped to the test stage. Documentation marks them insufficient for a verified `dev` completion without build disposition.
4. `idleTimeoutMs` semantics do not change.
5. Existing report JSON fields remain; new artifact paths and acceptance stages are additive.
6. `mimo_result level=full` provides the prior output-rich behavior.
7. MCP `mimo_status` changes its default shape intentionally; CLI status requests `standard` to retain useful human diagnostics.
8. Skill and docs stop directing Codex to consume `mimo_result.output` by default.
9. The prefetched callback contract changes from output-rich to compact; its version marker should advance to prevent contract ambiguity.

## Component boundaries

### Result and artifact layer

- `src/core/jobs.ts`: output-level result types, `stalled`, progress/checkpoint fields, acceptance stage types, report paths.
- `src/core/job-render.ts`: separate compact, standard, and full renderers with byte-budget enforcement.
- `src/core/job-output.ts`: artifact writing and explicit full-content reads.
- `src/compose/report.ts`: unified model-output, acceptance, checkpoint, and slice links.
- `src/notify/codex-adapter.ts`: compact-only prefetched callback payload.
- `src/codex/tool-schemas.ts`: level, progress timeout, acceptance, and batch mode inputs.

### Progress and continuation layer

- New focused progress classifier/monitor module under `src/core/`.
- `src/core/job-worker.ts`: observation persistence, stall timer integration, checkpoint writes, safe transition.
- `src/mimo/streaming-runner.ts`: distinct `stalled` termination request and process-tree teardown.
- `src/core/job-transition.ts`: legal stalled transition and attention signal.
- `src/core/job-signals.ts`: stalled attention and staged verification signals.
- `src/codex/tools.ts`: resumable-state policy and checkpoint-based `mimo_resume`.
- `src/core/prompt.ts`: focused continuation prompt that forbids broad rescanning.

### Acceptance and chain layer

- `src/compose/verify.ts`: staged command runner, fail-fast behavior, full evidence retention, framework failure extraction.
- `src/compose/post-checks.ts`: deterministic diff acceptance checks.
- `src/compose/workflow.ts`: dev stage contract and slice-planning prompt.
- New chain store/coordinator modules under `src/core/`.
- `src/core/job-supervisor.ts`: recover and advance one durable slice at a time.
- `src/core/job-definitions.ts`: planner, slice, review, and root finalization definitions.

The exact file split belongs in the implementation plan. New modules should remain small and expose named exported return types for declaration generation.

## Testing strategy

### Result contracts

- Compact success omits output, session, logs, events, diff, callback, and notification fields.
- Compact planning result includes only bounded summary plus the standard compact fields.
- Representative English and Chinese compact fixtures remain at or below 6,000 UTF-8 bytes.
- Reduction preserves failure, report path, and resume instruction.
- Standard includes only bounded key evidence.
- Full reads complete artifact content and reports `artifact_too_large` instead of silently truncating.
- Automatic Codex callback always receives compact data.

### Effective progress

- Any activity updates `lastActivityAt`.
- Reasoning/text alone does not update `lastProgressAt`.
- A new tool, changed file fingerprint, command completion, phase advance, or verification transition updates progress.
- Duplicate progress fingerprints do not extend the lease.
- Fake-clock tests show no transition before five minutes and `stalled` at the configured deadline.
- Transport idle and absolute timeout remain distinguishable.
- Process termination must be confirmed before resume becomes available.

### Continuation

- `needs_input`, `blocked`, `stalled`, timeout, and allowlisted acceptance failure create focused continuation children.
- A parent session ID is reused.
- Missing session falls back to checkpoint-only context without a broad scan instruction.
- Already completed slices and valid passed gates appear as do-not-repeat items.
- Relevant repository changes cause `resume_conflict`.
- Concurrent resume requests create only one continuation.

### Development acceptance

- Build runs before tests; tests run before diff checks.
- Build failure prevents test and review execution.
- Test failure prevents diff review.
- Missing build disposition or target test prevents completed status.
- Full failure output is stored while compact result exposes only bounded failed tests and suggestion.
- Diff review is read-only and a malformed verdict fails.
- Unexpected file scope or commit fails diff acceptance.
- A dev root cannot complete with an empty acceptance record.

### Slice chain

- Auto mode may produce one slice for a narrow objective.
- Invalid, cyclic, oversized, or acceptance-free manifests fail before editing.
- Dependencies execute in deterministic order.
- No two write children run concurrently.
- Successful child completion starts the next child without external notification.
- Failure or stall leaves later children pending.
- Supervisor restart does not duplicate a completed or live child.
- Root result aggregates changed files and acceptance results across all completed slices.

### Integration acceptance

Run a deterministic fake-MiMo development chain that:

1. Creates a two-slice manifest.
2. Completes the first slice.
3. Stalls the second after productive edits.
4. Reaches `stalled` within five minutes under a fake clock.
5. Returns one compact result with last command, reason, report path, and resume instruction.
6. Resumes the same session and skips the first slice.
7. Passes build, targeted tests, and diff review.
8. Completes the root with a compact result below the byte budget.

## Rollout

Implement in four independently verifiable phases:

1. Compact result levels and unified artifacts.
2. Effective-progress monitoring, stalled state, checkpoint, and resume.
3. Ordered development acceptance.
4. Durable automatic slice chain.

Each phase updates MCP schemas, CLI behavior, skill text, README, operations guide, Compose documentation, plugin validation contracts, and focused tests before the next phase begins.

This document defines one cross-cutting product contract, not one implementation batch. After
written-spec approval, each phase receives a separate implementation plan and acceptance checkpoint;
phase 2 planning starts only after phase 1 is verified, and so on.

During rollout:

- old and new job records must remain readable;
- no existing working-tree changes are overwritten;
- output-rich callback behavior is not removed until compact callback contract tests pass;
- progress timeout is enabled only after fake-clock and process-cleanup tests pass;
- automatic slicing is enabled by default only after crash recovery and duplicate-start tests pass.

## Acceptance criteria

- A normal successful implementation returns no complete model output, logs, or diff at compact level.
- Representative compact results consume no more than approximately 1,000–2,000 Codex tokens and never exceed the 6,000-byte JSON budget.
- Complete plans are stored in report artifacts; the main Codex session receives only a bounded summary and path.
- A running MiMo invocation with no effective progress becomes attention-visible within five minutes by default.
- A stalled result contains the sanitized last command, classified reason, and usable resume instruction.
- A stalled or timed-out task can continue from its session or checkpoint without repeating completed slices or broad project discovery.
- No development slice or root job is marked completed unless build disposition, targeted tests, deterministic diff checks, and read-only review have passed.
- A failed acceptance result names the first failed stage/command, failed test when recognizable, and shortest next repair action.
- A broad write objective is persisted as no more than eight dependency-aware slices and executes one write slice at a time.
- Running progress and child completion do not send logs or repeated progress text to Codex.
- Default heartbeat status is a very short state value.
- `standard` and `full` are available only through explicit caller choice.
- Full tests, type checking, build, plugin validation, and applicable smoke tests pass before release.
