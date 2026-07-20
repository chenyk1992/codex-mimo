# Cursor companion hooks for codex-mimo

When Cursor calls a MiMo work MCP tool, this companion:

1. Records `cwd` + `jobId` in `~/.codex-mimo/companion-watch.json`
2. On agent `stop`, checks the job record
3. Auto-submits a `followup_message` so the same chat continues with `mimo_status` / `mimo_result`

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

## Trial

1. Ask the agent to call `mimo_plan` with a short task and a valid git `cwd`.
2. After `queued` returns and the turn stops, Cursor should auto-follow up.
3. Inspect `~/.codex-mimo/companion-watch.json` if nothing happens.

## Layout

- Logic: `src/companion/watch.ts`
- Hook CLI: `dist/companion/cli.js` (from `npm run build`)
- Installer: `hosts/cursor/install.mjs`
