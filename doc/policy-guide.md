# 策略指南

## 默认策略

桥接层强制执行保守的默认策略：

### 文件访问

| 模式 | 读取 | 写入 |
|---------|------|-------|
| `${workspaceRoot}/**` | 允许 | 询问 |
| `**/.env`、`**/.env.*` | 拒绝 | 拒绝 |
| `**/id_rsa`、`**/id_ed25519` | 拒绝 | 拒绝 |
| `**/.npmrc`、`**/.pypirc` | 拒绝 | 拒绝 |
| 工作区外 | 拒绝 | 拒绝 |

### 终端命令

| 模式 | 决策 |
|---------|----------|
| `git status*`、`git diff*`、`git log*` | 允许 |
| `npm test*`、`npm run test*`、`npm run lint*`、`npm run typecheck*` | 允许 |
| `pnpm test*`、`pnpm lint*`、`pnpm typecheck*` | 允许 |
| `npm install*`、`pnpm install*` | 询问 |
| `npm run build*`、`pnpm build*` | 询问 |
| `rm *`、`del *`、`Remove-Item *` | 拒绝 |
| `git push*`、`git reset*`、`git checkout --*` | 拒绝 |
| `curl *`、`wget *`、`ssh *`、`scp *` | 拒绝 |

### 网络

默认：拒绝。除非工作流明确启用，否则不允许网络访问。

## 自定义策略

在项目根目录提供 `codex-mimo.config.json` 来覆盖默认值：

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

## 审计日志

每次调用都会将 JSONL 审计日志写入 `.codex-mimo/audit.jsonl`：

```json
{"type":"session_start","workflow":"implement","cwd":"E:/project/app","agent":"build"}
{"type":"permission","operation":"terminal","command":"npm test","outcome":"allow"}
{"type":"file_write","path":"E:/project/app/src/login.ts","bytes":940}
{"type":"session_end","stopReason":"end_turn","changedFiles":["src/login.ts"]}
```
