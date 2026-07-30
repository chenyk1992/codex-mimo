# Cursor Delivery

Read this reference only when the host is Cursor.

## With the Companion

Install the companion hooks documented in `hosts/cursor/README.md`.

1. Call one work tool with the complete task and workspace.
2. Return the queued receipt and stop. Do not call `mimo_status`, `mimo_events`, or `mimo_wait` while the job is active.
3. The companion stop hook waits until the job needs attention or becomes terminal, then submits a short follow-up.
4. On that follow-up, call compact `mimo_result` with the receipt's `jobId`, inspect relevant changes, and verify independently.

## Without the Companion

1. Call one work tool with the complete task and workspace.
2. Return the queued receipt and `jobId`, then stop.
3. If the user explicitly insists on waiting in-session, call at most one `mimo_wait`, then at most one `mimo_status` if needed. Stop again.
4. When the user returns after attention or completion, call compact `mimo_result`.

Never poll or loop on control tools. Cursor companion launches omit Codex notify and use the companion wake path.
