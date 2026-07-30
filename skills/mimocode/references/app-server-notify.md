# Codex App Server Notify

Read this reference only for an explicit CLI compatibility/history-writeback launch. This is not the default Codex Desktop path.

Send the current task ID explicitly:

```text
notify: { type: "codex", threadId: "<current-task-id>" }
```

Read `CODEX_THREAD_ID` from the task command environment and pass it as `notify.threadId`. Never configure it globally. Webhook and Codex notification settings are mutually exclusive.

The bridge discovers the Codex command from `configured`, `path`, or Windows `desktop-local` sources. It tries Desktop version folders before the stable root CLI because the root CLI can be older. `CODEX_MIMO_CODEX_BIN` is the authoritative optional override. `mimo_healthcheck` and `doctor` report basic CLI readiness only; an explicit notify launch performs target-aware preflight before creating a job.

On preflight failure, report the safe code and stop:

- `codex_cli_not_found`: configure `CODEX_MIMO_CODEX_BIN`, restart Codex Desktop, then run `mimo_healthcheck`.
- `codex_cli_not_executable`: the command could not spawn, including protected WindowsApps binaries; configure a standalone CLI outside WindowsApps, restart Desktop, then run `mimo_healthcheck`.
- `codex_app_server_unavailable`: verify the selected CLI with `mimo_healthcheck`.

Do not automatically relaunch without `notify`. Only an explicit user choice may switch to the no-notify Desktop heartbeat or Cursor companion path after seeing the diagnostic.

After a successful launch, return the queued receipt and stop. The notify worker may start one callback turn whose prompt already contains the public result; that callback answers from the supplied result without tools. Outbox `delivered` means the independent callback completed. It does not mean the Desktop UI, renderer, or visible task refreshed.

CLI users may intentionally omit notifications or supply `--notify codex --thread-id <id>`. Direct user requests for status, result, events, or one wait remain valid diagnostics.
