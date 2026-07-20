# Cursor companion hooks for codex-mimo

When Cursor calls a MiMo work MCP tool, this companion:

1. Records `cwd` + `jobId` in `~/.codex-mimo/companion-watch.json`
2. On agent `stop`, waits for the job to finish (no polling from the agent)
3. Auto-submits a `followup_message` so the same chat continues with only `mimo_result`

You do **not** need to ask manually in the original session.

## Install

```powershell
cd E:\IdeaProject\codex-mimo
npm run build
node hosts/cursor/install.mjs --user      # all Cursor workspaces
# or
node hosts/cursor/install.mjs --project  # current repo only
```

Reload Cursor hooks (Settings → Hooks, or restart Cursor).

Also configure the **codex-mimocode** MCP server in Cursor, and use a git workspace `cwd` (with commits) for jobs.

## Trial (zero-poll)

1. Build and install hooks: `npm run build`, then `node hosts/cursor/install.mjs --user` (or `--project`).
2. Reload Cursor hooks (Settings → Hooks, or restart Cursor).
3. Ask the agent to call `mimo_plan` with a short task and a valid git `cwd`, then stop. The agent must **not** call `mimo_status`, `mimo_events`, or `mimo_wait` while the job is running.
4. The stop hook may run for a long time while the job finishes — that is expected. When the job completes, Cursor auto-follows up and asks only for `mimo_result`.
5. Optional: set `CODEX_MIMO_COMPANION_WAIT_SEC=60` for a short exhausted diagnostic (hook returns quickly instead of waiting the full job duration).
6. Inspect `~/.codex-mimo/companion-watch.json` if nothing happens.

## Layout

- Logic: `src/companion/watch.ts`
- Hook CLI: `dist/companion/cli.js` (from `npm run build`)
- Installer: `hosts/cursor/install.mjs`
