# Unified Background Jobs Release Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the unified background Job and active-notification branch from the current security-fixed HEAD through independent review, fresh verification, the real packaged Codex gate, whole-branch review, and a user-selected branch-finishing action.

**Architecture:** This plan does not redesign or reimplement Tasks 1–13. It treats commit `7c5485d` as the current candidate, proves the final webhook-secret isolation across every MiMo process, then validates the approved 13-tool/background-notification contract from focused tests through packaged smoke. Any confirmed review finding is repaired in one TDD fix wave and re-reviewed before later gates are allowed to proceed.

**Tech Stack:** TypeScript 5.7, Node.js 22 ESM/NodeNext, Vitest 2, Zod 3, MCP SDK 1.29, Execa 9, PowerShell on Windows, filesystem JSONL job/outbox state, Codex App Server stdio JSONL.

## Global Constraints

- Do not re-execute implementation Tasks 1–13 and do not redesign the approved architecture.
- The branch base is `1670ef1648ebecbe6c99b2a07080fd0cc83e7683`; the candidate starts at `7c5485d` or a later review-fix descendant.
- Work only in `.worktrees/unified-background-notifications` on `codex/unified-background-notifications`.
- Preserve all user changes. Never reset, discard, clean, overwrite, or stage an unknown modification.
- Never commit `.mimocode/.cron-lock`, `.codex-mimo/` runtime state, secrets, audit output, temporary reports, or smoke directories.
- Keep exactly 13 public MCP tools: `mimo_healthcheck`, `mimo_plan`, `mimo_implement`, `mimo_review`, `mimo_fix_ci`, `mimo_resume`, `mimo_compose`, `mimo_status`, `mimo_events`, `mimo_wait`, `mimo_result`, `mimo_cancel`, and `mimo_jobs`.
- All six work tools return only a queued receipt and always execute as background Jobs.
- `mimo_wait` is attention-only and diagnostic; packaged guidance must never instruct Codex to poll it.
- All status mutations use the unique transition API. Notifications use the durable outbox and never change the Job outcome.
- All MiMo processes, including `mimo run` and `mimo --version`, omit every persisted webhook `secretEnv` name. Windows comparison is case-insensitive; POSIX comparison remains case-sensitive.
- The notification worker retains access to its own environment so it can generate webhook HMAC signatures. Secret values never enter Job, Signal, Report, JSONL, log, audit, error, or notification payload persistence.
- Run verification commands serially. Do not run Vitest/tinypool or worker-producing commands in parallel on Windows.
- Only current-run command output and exit codes count as completion evidence.
- Do not merge, push, remove the worktree, or delete a branch until the user explicitly selects a finishing option.

## File Responsibility Map

### Candidate implementation and security boundary

- `src/core/encoding.ts` — immutable environment filtering and platform-specific name comparison.
- `src/core/job-store.ts` — discovery of persisted webhook secret environment-variable names.
- `src/core/job-worker.ts` — passes the complete protected-name set to the MiMo execution path.
- `src/mimo/run-json.ts` — constructs the safe environment for MiMo version probes.
- `src/mimo/streaming-runner.ts` — the only `mimo run --format json` spawn boundary.
- `src/notify/outbox.ts` — retained notification targets included by protected-name discovery.
- `src/notify/worker.ts` and `src/notify/webhook-adapter.ts` — notification process retains the secret and computes HMAC without persisting it.

### Focused acceptance tests

- `test/unit/windows-encoding.test.ts`
- `test/unit/mimo-version-probes.test.ts`
- `test/unit/core/job-worker.test.ts`
- `test/unit/mimo-streaming-runner.test.ts`
- `test/unit/job-store.test.ts`
- `test/unit/notify/outbox.test.ts`
- `test/unit/notify/dispatcher.test.ts`
- `test/unit/notify/worker.test.ts`
- `test/unit/notify/webhook-adapter.test.ts`
- `test/unit/notify/codex-app-server.test.ts`
- `test/unit/notify/codex-adapter.test.ts`
- `test/unit/mcp-tool-audit.test.ts`
- `test/unit/mcp-strict-input-validation.test.ts`
- `test/unit/mcp-work-schema-registration.test.ts`
- `test/unit/codex-tools.test.ts`
- `test/unit/tool-schemas.test.ts`
- `test/unit/plugin-validator.test.ts`
- `test/unit/cross-cutting/process-management.test.ts`
- `test/integration/unified-background-jobs.test.ts`

### Packaged and real-machine gates

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `skills/mimocode/SKILL.md`
- `scripts/validate-plugin.mjs`
- `test/smoke/local-mimo-hooks.test.ts`
- `test/smoke/local-codex-notification.test.ts`

### Documentation and execution ledger

- `docs/superpowers/specs/2026-07-16-background-job-notification-design.md` — approved source of truth.
- `docs/superpowers/plans/2026-07-16-unified-background-jobs-notifications.md` — completed Tasks 1–13 plan.
- `.superpowers/sdd/progress.md` — durable execution/review record; update only after gates are genuinely complete.

---

### Task 1: Freeze the Candidate and Independently Re-review Secret Isolation

**Files:**
- Review: `src/core/encoding.ts`
- Review: `src/core/job-store.ts`
- Review: `src/core/job-worker.ts`
- Review: `src/mimo/run-json.ts`
- Review: `src/mimo/streaming-runner.ts`
- Review: `src/notify/outbox.ts`
- Review: `src/notify/worker.ts`
- Review: `src/notify/webhook-adapter.ts`
- Review: `test/unit/windows-encoding.test.ts`
- Review: `test/unit/mimo-version-probes.test.ts`
- Review: `test/unit/core/job-worker.test.ts`

**Interfaces:**
- Consumes: `omitEnvironmentVariables(sourceEnv, omittedNames, options)`, `withUtf8ProcessEnv(env, options)`, the persisted Job records, and the retained notification outbox.
- Produces: a reviewer verdict with exact `Critical`, `Important`, and `Minor` counts and no file modifications.

- [ ] **Step 1: Classify the plan-authoring worktree change**

Run:

```powershell
git status --short
git diff --check
```

Expected before plan execution: the only change is this approved plan at `docs/superpowers/plans/2026-07-18-unified-background-jobs-release-closure.md`. If any other path appears, stop and classify it as an existing user change, runtime artifact, or unexpected modification; do not stage it.

- [ ] **Step 2: Commit the approved execution plan by itself**

Run only after the user selects an execution mode:

```powershell
git add docs/superpowers/plans/2026-07-18-unified-background-jobs-release-closure.md
git diff --cached --check
git commit -m "docs: add release closure plan"
```

Expected: one documentation-only commit. Re-run `git status --short` and require an empty result.

- [ ] **Step 3: Re-establish the immutable candidate state**

Run:

```powershell
git status --short
git branch --show-current
git log --oneline --decorate -8
git diff --check
```

Expected:

- Branch is `codex/unified-background-notifications`.
- HEAD contains `7c5485d`, `20b3b78`, and `a2ce8f2`.
- `git status --short` is empty. If it is not empty, stop and classify every path before continuing.
- `git diff --check` exits 0.

- [ ] **Step 4: Dispatch a new read-only security reviewer**

The reviewer must inspect the candidate rather than trusting prior reports. Its checklist is:

```text
1. Every `mimo run` child omits all webhook secret names persisted in any Job or retained outbox delivery for the cwd.
2. Both healthcheck and doctor `mimo --version` probes use the same protected-name collector and filtering boundary.
3. Windows removes all casing-equivalent keys; POSIX retains case-sensitive behavior.
4. Input env objects and process.env are not mutated.
5. Notification workers still read the secret and produce the expected HMAC.
6. No MiMo spawn bypasses the shared filtering method.
7. No secret value can enter errors, logs, audit, Job, Signal, Report, event JSONL, outbox snapshots, or notification payloads.
8. Cross-Job and retained-outbox tests fail under the old implementation and pass under the candidate.
```

Expected verdict: `Critical 0 / Important 0 / Minor 0`.

- [ ] **Step 5: Apply the review gate**

- If the reviewer reports any confirmed finding, do not start Task 2.
- Collect all findings into the single remediation loop in Task 6.
- After a remediation commit, repeat all of Task 1 using a different reviewer.
- If the reviewer reports zero findings, record the reviewer identity, HEAD, and verdict in the execution report.

---

### Task 2: Run the Fresh Focused Acceptance Suite

**Files:**
- Test: all focused files listed in the File Responsibility Map.

**Interfaces:**
- Consumes: the security-reviewed HEAD from Task 1.
- Produces: current-run evidence for secret isolation, Job/worker recovery, outbox durability, Codex exactly-once behavior, strict schemas, audits, and Windows process handling.

- [ ] **Step 1: Run the security and runtime focused tests**

Run exactly one Vitest process:

```powershell
npm.cmd test -- test/unit/windows-encoding.test.ts test/unit/mimo-version-probes.test.ts test/unit/core/job-worker.test.ts test/unit/mimo-streaming-runner.test.ts test/unit/job-store.test.ts test/unit/notify/outbox.test.ts test/unit/notify/dispatcher.test.ts test/unit/notify/worker.test.ts test/unit/notify/webhook-adapter.test.ts test/unit/notify/codex-app-server.test.ts test/unit/notify/codex-adapter.test.ts test/unit/cross-cutting/process-management.test.ts
```

Expected: exit 0. Record the exact test-file count, passed count, skipped count, duration, and any warning.

- [ ] **Step 2: Run the public-contract and audit focused tests**

Run:

```powershell
npm.cmd test -- test/unit/mcp-tool-audit.test.ts test/unit/mcp-strict-input-validation.test.ts test/unit/mcp-work-schema-registration.test.ts test/unit/codex-tools.test.ts test/unit/tool-schemas.test.ts test/unit/plugin-validator.test.ts test/unit/packaged-skill.test.ts
```

Expected:

- Exit 0.
- Exactly 13 MCP tools are registered.
- All schemas reject unknown properties.
- Removed tools and fields are absent.
- Packaged skill contains no polling loop guidance.
- Audit remains opt-in and stores only the allowlisted metadata.

- [ ] **Step 3: Run the complete fake-process integration matrix**

Run:

```powershell
npm.cmd test -- test/integration/unified-background-jobs.test.ts
```

Expected: exit 0 with every current table row and dedicated case passing. The output must cover at least the approved 16 scenarios plus later security regressions, including:

- Six Job kinds.
- Verification failure and missing execution callback.
- Timeout and cancellation.
- `needs_input` and `blocked`.
- job-worker crash/restart without rerunning MiMo.
- notification-worker crash/restart with expired-lease recovery.
- Webhook HMAC, event-ID deduplication, and secret-value non-persistence.
- Fake App Server stdio JSONL delivery.
- Same Job: `mimo_result = 1`, `mimo_wait = 0`.
- Same thread: `thread/resume = 1`, `turn/start = 1`.
- Windows mixed-case secret isolation.

- [ ] **Step 4: Treat any failure as a release blocker**

For the first failing command:

1. Preserve the full failure output.
2. Do not continue to later verification commands.
3. Use `superpowers:systematic-debugging` before proposing a cause.
4. Enter Task 6 with a failing regression test that reproduces the defect.
5. After the fix and re-review, restart Task 2 from Step 1.

---

### Task 3: Run the Fresh Serial Release Verification

**Files:**
- Verify: complete repository, built `dist/`, plugin manifest/config, packaged skill, and real local MiMo hook integration.

**Interfaces:**
- Consumes: the focused acceptance evidence from Task 2.
- Produces: the only test/build/lint/plugin/hook evidence allowed in the final completion report.

- [ ] **Step 1: Run the complete test suite**

Run:

```powershell
npm.cmd test
```

Expected: exit 0. Capture the exact suite count, test count, skipped count, start time, and duration from this run.

- [ ] **Step 2: Build the runtime and declaration output**

Run:

```powershell
npm.cmd run build
```

Expected: exit 0 from `tsc -p tsconfig.json`.

- [ ] **Step 3: Run strict TypeScript validation**

Run:

```powershell
npm.cmd run lint
```

Expected: exit 0 from `tsc -p tsconfig.json --noEmit`.

- [ ] **Step 4: Validate the packaged plugin contract**

Run:

```powershell
npm.cmd run validate:plugin
```

Expected: exit 0 and `Plugin validation passed` for the feature worktree.

- [ ] **Step 5: Run the real local MiMo hook smoke**

Run:

```powershell
$env:RUN_LOCAL_MIMO_HOOK_SMOKE = '1'
$mimoHookSmokeExit = 1
try {
  npm.cmd run test:smoke:mimo-hooks
  $mimoHookSmokeExit = $LASTEXITCODE
} finally {
  Remove-Item Env:RUN_LOCAL_MIMO_HOOK_SMOKE -ErrorAction SilentlyContinue
}
if ($mimoHookSmokeExit -ne 0) { exit $mimoHookSmokeExit }
```

Expected: exit 0 with 2/2 smoke tests passed. A Node deprecation warning is recorded as a warning, not silently omitted; any test failure remains blocking.

- [ ] **Step 6: Verify diff hygiene and process cleanup**

Run:

```powershell
git diff --check
git status --short
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match 'node|mimo|codex' -and
  $_.CommandLine -match 'fake-mimo|fake-codex|process-job-worker|process-notify-worker|local-mimo-hooks|vitest|tinypool'
} | Select-Object ProcessId, Name, CommandLine
```

Expected:

- `git diff --check` exits 0.
- `git status --short` is empty.
- No test-owned Vitest/tinypool, fake MiMo, fake App Server, job-worker, notification-worker, or hook-server process remains.
- If a process remains, identify its exact command line and ownership before stopping it; never kill unrelated Node/Codex processes.

---

### Task 4: Execute and Classify the Real Packaged Codex Gate

**Files:**
- Verify: `.codex-plugin/plugin.json`
- Verify: `.mcp.json`
- Verify: `dist/codex/mcp-server.js`
- Test: `test/smoke/local-codex-notification.test.ts`

**Interfaces:**
- Consumes: built packaged MCP, task-injected `CODEX_THREAD_ID`, real Codex App Server, real MiMoCode, and opt-in safe audits.
- Produces: exactly one status: `PASS`, `FAIL`, or `NOT RUN — ENVIRONMENT BLOCKED`.

- [ ] **Step 1: Check prerequisites without globally setting the thread ID**

Run:

```powershell
codex --version
$codexProbeExit = $LASTEXITCODE
Write-Output "codex --version exit code: $codexProbeExit"
if ([string]::IsNullOrWhiteSpace($env:CODEX_THREAD_ID)) {
  Write-Output 'CODEX_THREAD_ID is not injected in this task.'
}
```

Rules:

- Never create a global Windows `CODEX_THREAD_ID`.
- If `codex --version` returns Windows `Access is denied`, record the exact command and error as an environment restriction.
- If the task has no injected `CODEX_THREAD_ID`, the real callback gate cannot validly target the current task.

- [ ] **Step 2: Run the gated smoke only when prerequisites are available**

Run from an idle, dedicated Codex task:

```powershell
$env:RUN_LOCAL_CODEX_NOTIFY_SMOKE = '1'
$codexNotifySmokeExit = 1
try {
  npm.cmd run test:smoke:codex-notify
  $codexNotifySmokeExit = $LASTEXITCODE
} finally {
  Remove-Item Env:RUN_LOCAL_CODEX_NOTIFY_SMOKE -ErrorAction SilentlyContinue
}
if ($codexNotifySmokeExit -ne 0) { exit $codexNotifySmokeExit }
```

PASS requires all of the following evidence from this run:

- The server starts from built MCP and packaged config.
- The work tool immediately returns a queued receipt.
- The original Codex task is resumed.
- `thread/resume` occurs exactly once.
- `turn/start` occurs exactly once.
- The corresponding Job records `mimo_result` exactly once.
- The corresponding Job records `mimo_wait` zero times.
- The resumed turn writes the observable result marker required by the smoke.
- MCP audit contains no payload, prompt, secret, or unvalidated input.
- App Server audit contains no RPC payload or prompt.

- [ ] **Step 3: Classify the gate honestly**

- `PASS`: the gated command ran and every assertion passed.
- `FAIL`: the command ran under valid prerequisites and an implementation assertion failed. Enter Task 6.
- `NOT RUN — ENVIRONMENT BLOCKED`: prerequisites failed because of host permission, missing injected task identity, or unavailable real App Server. Record the exact command, exit code, and error. Do not label this PASS or an implementation failure.
- Keep fake App Server protocol/integration results separate from the real gate status.

---

### Task 5: Perform Two Independent Whole-Branch Reviews

**Files:**
- Review range: `1670ef1648ebecbe6c99b2a07080fd0cc83e7683..HEAD`
- Review: all changed production, test, plugin, skill, and documentation files.

**Interfaces:**
- Consumes: approved design, completed Tasks 1–13, all later remediation commits, and Task 2–4 evidence.
- Produces: two independent read-only verdicts with exact severity counts.

- [ ] **Step 1: Load the review workflow and create one complete diff package**

Read `superpowers:requesting-code-review` completely. Generate the package using the SDD `review-package` script with the fixed design base and current HEAD; never use `HEAD~1`.

The package must contain:

- Commit list for the full range.
- Diff stat.
- Complete unified diff with context.
- No secrets or runtime artifacts.

- [ ] **Step 2: Dispatch Reviewer A — Runtime, security, and recovery**

Reviewer A checks:

```text
Job legal state graph and unique transition API.
Outbox idempotency, physical-path mutex, lease generation, renewal, retry, and stale-owner rejection.
job-worker and notification-worker crash recovery.
Stale queued/running recovery without duplicate MiMo execution.
Cancellation acknowledgement and owned process identity.
HTTP/RPC deadlines and AbortSignal propagation.
Windows atomic rename bounded retry.
Windows taskkill process-tree liveness confirmation.
All persisted webhook-secret isolation and HMAC availability.
Codex resume/start/result exactly-once behavior.
No secret, prompt, payload, raw diff, or raw RPC body in durable/audit surfaces.
```

- [ ] **Step 3: Dispatch Reviewer B — Public contract, CLI, plugin, and documentation**

Reviewer B checks:

```text
Exactly 13 MCP tools.
Six work tools return the same queued receipt.
Schema registration and handler validation have one strict source.
CLI distinguishes input errors from runtime errors with the documented exit codes.
mimo_wait is attention-only and diagnostic.
No mimo_wake, mimo_resume_job, background, public wait, public pollMs, deprecated alias, or forwarding shim.
Packaged skill does not instruct polling.
README, operations guide, Compose guide, plugin manifest/config, and actual runtime agree.
CODEX_THREAD_ID is task-injected and not a global Windows setup requirement.
Audit defaults off and contains no sensitive input.
No dead code, duplicate implementation, compatibility layer, or invalid abstraction remains.
```

- [ ] **Step 4: Apply the whole-branch review gate**

Required release verdict: `Critical 0 / Important 0 / Minor 0` from both reviewers.

- Any confirmed finding enters Task 6.
- After remediation, send the complete fix range to the reviewer who raised it for targeted re-review.
- If a fix changes cross-cutting runtime or public contract behavior, repeat both Reviewer A and Reviewer B.
- Do not replace independent review with the implementer's self-review.

---

### Task 6: Remediate Any Confirmed Finding with One TDD Fix Wave

**Files:**
- Modify/Test: only the exact paths cited by confirmed reviewer or verification evidence.

**Interfaces:**
- Consumes: the complete list of confirmed findings from the current gate.
- Produces: one minimal fix series, attributable RED→GREEN evidence per defect, and targeted re-review approval.

- [ ] **Step 1: Verify every finding against the current code**

Use `superpowers:receiving-code-review`. For every item, record:

- Exact file and line.
- Violated approved requirement.
- Reproduction path.
- Whether it is confirmed or rejected with technical evidence.

Do not implement speculative or contradicted feedback.

- [ ] **Step 2: Dispatch one fresh fix subagent with the complete confirmed list**

The subagent uses `superpowers:test-driven-development` and must:

1. Add the smallest regression test for the first defect.
2. Run it against the unfixed behavior and capture the expected failure.
3. Implement the smallest general fix.
4. Run the focused test and capture GREEN.
5. Repeat for the remaining confirmed defects without unrelated refactoring.
6. Run all directly affected tests, build, lint, and `git diff --check`.
7. Commit with a precise message; do not stage runtime or user files.

- [ ] **Step 3: Inspect the commit and re-review it**

Run:

```powershell
git status --short
git show --stat --oneline HEAD
git show --check HEAD
```

Dispatch a fresh read-only reviewer with the finding list, RED/GREEN report, and exact fix range. All severities must be zero before leaving Task 6.

- [ ] **Step 4: Restart the invalidated gates**

- Security/data-flow fix: restart Task 1.
- Focused/integration failure: restart Task 2.
- Build/lint/plugin/hook failure: restart Task 3, then Tasks 4–5.
- Real Codex implementation failure: restart Task 2, Task 3, and Task 4.
- Whole-branch finding: rerun its targeted reviewer; rerun both reviewers for cross-cutting changes.

---

### Task 7: Record Completion Evidence and Prepare Branch Handoff

**Files:**
- Modify: `.superpowers/sdd/progress.md`
- Review: Git history and worktree status.

**Interfaces:**
- Consumes: zero-finding reviews and all current-run verification evidence.
- Produces: durable ledger entry and the final user-facing completion report.

- [ ] **Step 1: Update the SDD progress ledger**

Append one concise closure entry that records the actual final HEAD hash, states that the Windows/cross-Job/outbox secret-isolation review is clean, lists the fresh suite/build/lint/plugin/hook results, records the actual real-Codex gate classification, and records Reviewer A and Reviewer B severity counts. Do not use placeholders or copy a status that was not observed.

Do not rewrite or re-dispatch Tasks 1–13. The ledger is ignored scratch state and must not be staged unless repository policy explicitly changes.

- [ ] **Step 2: Run the final repository-state checks**

Run:

```powershell
git status --short
git diff --check
git log --oneline --decorate -15
git ls-files .mimocode/.cron-lock .codex-mimo
```

Expected:

- Worktree clean.
- Diff check clean.
- All remediation changes committed.
- No runtime lock, secret, audit output, or `.codex-mimo` state tracked.

- [ ] **Step 3: Produce the final completion report**

Report exactly:

1. Latest commit list.
2. Every test command with exact current-run file/test/pass/skip counts and exit code.
3. Build, lint, plugin validation, and hook-smoke results.
4. Real Codex gate: `PASS`, `FAIL`, or `NOT RUN — ENVIRONMENT BLOCKED`, with evidence.
5. Reviewer A and B severity counts.
6. `git status --short` result.
7. Line-by-line approved-spec completion criteria mapping.
8. Remaining environment limitations and non-blocking risks.

No completion claim is allowed until this report can be supported by current-run evidence.

---

### Task 8: Offer the User-Controlled Branch Finishing Choices

**Files:**
- No repository changes unless the user chooses an integration action.

**Interfaces:**
- Consumes: the clean, verified feature branch and final report.
- Produces: a user decision; no automatic merge, push, worktree removal, or branch deletion.

- [ ] **Step 1: Load the finishing workflow**

Read `superpowers:finishing-a-development-branch` completely. Detect whether the checkout is a named worktree or a normal repository without modifying it.

- [ ] **Step 2: Present exactly four choices**

```text
1. 本地合并回基线分支。
2. 推送并创建 Pull Request。
3. 保留 feature branch 和 worktree。
4. 丢弃此次工作。
```

- [ ] **Step 3: Wait for explicit authorization**

Before the user chooses, do not execute:

- `git merge`
- `git push`
- PR creation
- `git worktree remove`
- Branch deletion
- Any discard/reset command

After the user chooses, execute only the selected finishing path and re-check repository/worktree state afterward.

## Final Completion Criteria

- Latest secret isolation commit has an independent `Critical 0 / Important 0 / Minor 0` security re-review.
- Focused runtime/security/public-contract tests pass on the current HEAD.
- The full integration matrix passes, including worker restart, HMAC, audit, exactly-once callback, and zero-wait evidence.
- Fresh serial `npm test`, build, lint, plugin validation, real MiMo hook smoke, and diff check all exit 0.
- Real Codex gate is truthfully classified and never inferred from fake protocol tests.
- Both whole-branch reviewers report `Critical 0 / Important 0 / Minor 0` after any remediation.
- Worktree is clean and every repository change is committed.
- No runtime file, secret, audit output, or temporary directory is tracked.
- The final approved-spec mapping and environment-risk report are delivered.
- No merge, push, worktree removal, branch deletion, or discard occurs before explicit user selection.
