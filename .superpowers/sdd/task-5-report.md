# Task 5 report: discovery diagnostics and packaging documentation

## Delivered

- `mimo_healthcheck` continues to report MiMo runtime health at the top level
  and exposes Codex basic CLI readiness separately through
  `codexNotification`.
- `codex-mimo doctor` now labels this as **Codex notification CLI readiness**,
  includes the safe discovery source (`configured`, `path`, or
  `desktop-local`), and states that an explicit notify launch performs the
  separate target-aware preflight before a job is created. Overall doctor
  health remains independent of Codex notification readiness.
- README, operations guide, MiMoCode skill, and build/install skill now
  document unified Windows Desktop-local discovery, version-folder precedence
  over a potentially older stable root CLI, and `CODEX_MIMO_CODEX_BIN` as the
  authoritative optional override.
- The public contract preserves explicit `notify.threadId`, target-aware launch
  preflight, and no silent fallback to no-notify delivery. `.mcp.json` was not
  changed and continues to forward only `CODEX_MIMO_CODEX_BIN`.

## TDD evidence

### RED

After adding the doctor and public-contract expectations, the focused command

```powershell
npm test -- doctor.test.ts mimo-healthcheck.test.ts public-release-contract.test.ts
```

failed as expected: doctor still emitted the old source-free CLI line, and the
skill documents did not yet describe `desktop-local` discovery.

### GREEN

- `npm test -- doctor.test.ts mimo-healthcheck.test.ts public-release-contract.test.ts`
  — 27 passed.
- `npm test -- codex-command.test.ts codex-connection.test.ts job-launcher.test.ts dispatcher.test.ts codex-adapter.test.ts doctor.test.ts mimo-healthcheck.test.ts public-release-contract.test.ts`
  — 126 passed.
- `npm run lint` — passed.
- `npm run build` — passed.
- `npm run validate:plugin` — passed.
- `git diff --check` — passed (Git reported only line-ending conversion warnings).
