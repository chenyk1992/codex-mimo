# Policy Guide

## Default Policy

The bridge enforces a conservative default policy:

### File Access

| Pattern | Read | Write |
|---------|------|-------|
| `${workspaceRoot}/**` | allow | ask |
| `**/.env`, `**/.env.*` | deny | deny |
| `**/id_rsa`, `**/id_ed25519` | deny | deny |
| `**/.npmrc`, `**/.pypirc` | deny | deny |
| Outside workspace | deny | deny |

### Terminal Commands

| Pattern | Decision |
|---------|----------|
| `git status*`, `git diff*`, `git log*` | allow |
| `npm test*`, `npm run test*`, `npm run lint*`, `npm run typecheck*` | allow |
| `pnpm test*`, `pnpm lint*`, `pnpm typecheck*` | allow |
| `npm install*`, `pnpm install*` | ask |
| `npm run build*`, `pnpm build*` | ask |
| `rm *`, `del *`, `Remove-Item *` | deny |
| `git push*`, `git reset*`, `git checkout --*` | deny |
| `curl *`, `wget *`, `ssh *`, `scp *` | deny |

### Network

Default: deny. Network access is not enabled unless a workflow explicitly permits it.

## Customizing Policy

Override defaults by providing a `codex-mimo.config.json` in your project root:

```jsonc
{
  "workspaceRoot": ".",
  "fileAccess": {
    "read": ["${workspaceRoot}/**"],
    "write": ["${workspaceRoot}/src/**"],
    "deny": ["**/.env*"]
  },
  "terminal": {
    "allow": ["npm test*"],
    "ask": ["npm install*"],
    "deny": ["git push*"]
  }
}
```

## Audit Logs

Every invocation writes a JSONL audit log to `.codex-mimo/audit.jsonl`:

```json
{"type":"session_start","workflow":"implement","cwd":"E:/project/app","agent":"build"}
{"type":"permission","operation":"terminal","command":"npm test","outcome":"allow"}
{"type":"file_write","path":"E:/project/app/src/login.ts","bytes":940}
{"type":"session_end","stopReason":"end_turn","changedFiles":["src/login.ts"]}
```
