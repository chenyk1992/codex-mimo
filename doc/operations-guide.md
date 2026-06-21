# Operations Guide

## Enabling the Bridge

1. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

2. Verify MiMoCode is available:
   ```bash
   codex-mimo healthcheck
   ```

3. The plugin is auto-discovered by Codex from `.codex-plugin/plugin.json`.

## Disabling the Bridge

### Option 1: Remove the plugin

Delete the plugin directory or remove it from the marketplace:

```bash
# From the marketplace
codex plugin remove codex-mimocode
```

### Option 2: Disable MCP server

Rename or delete `.mcp.json` to prevent MCP server startup:

```bash
mv .mcp.json .mcp.json.disabled
```

### Option 3: Disable via config

Set the plugin as unavailable in the marketplace:

```json
{
  "policy": {
    "installation": "NOT_AVAILABLE"
  }
}
```

## Rollback

If the bridge causes issues:

1. **Immediate:** Remove `.mcp.json` to stop the MCP server
2. **Audit:** Check `.codex-mimo/audit.jsonl` for recent operations
3. **Sessions:** Check `.codex-mimo/sessions.json` for active sessions
4. **Config:** Remove or rename `codex-mimo.config.json` to reset to defaults

## Configuration Reference

### `codex-mimo.config.json`

```jsonc
{
  // Override workspace root (default: process.cwd())
  "workspaceRoot": ".",

  // File access policy
  "fileAccess": {
    "deny": ["**/.env*", "**/id_rsa"]
  },

  // Terminal command policy
  "terminal": {
    "allow": ["git status*", "npm test*"],
    "ask": ["npm install*"],
    "deny": ["git push*", "rm *"]
  },

  // CI mode: auto-deny all "ask" decisions
  "ci": {
    "enabled": false
  },

  // Audit log settings
  "audit": {
    "maxFileSize": 10485760,  // 10MB
    "maxFiles": 5
  },

  // MCP server allowlist (empty = allow all)
  "mcpServers": {
    "allowlist": ["codex-mimocode"]
  }
}
```

## Monitoring

### Audit Log

Location: `.codex-mimo/audit.jsonl`

Events:
- `session_start` — Session initiated
- `permission` — Permission decision (allow/deny)
- `file_read` — File read attempt
- `file_write` — File write attempt
- `terminal_create` — Terminal command executed
- `session_end` — Session completed

### Session Store

Location: `.codex-mimo/sessions.json`

List sessions: `codex-mimo sessions`

## Troubleshooting

| Issue | Action |
|-------|--------|
| `mimo not found` | Install MiMoCode CLI |
| Permission denied | Check `codex-mimo.config.json` policy |
| Audit log too large | Adjust `audit.maxFileSize` in config |
| MCP server not starting | Check `node dist/codex/mcp-server.js` manually |
| Session not found | Run `codex-mimo sessions` to list |
