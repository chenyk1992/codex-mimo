# 运维指南

## 启用桥接

1. 安装依赖并构建：
   ```bash
   npm install
   npm run build
   ```

2. 验证 MiMoCode 可用：
   ```bash
   codex-mimo healthcheck
   ```

3. 插件通过 `.codex-plugin/plugin.json` 被 Codex 自动发现。

## 禁用桥接

### 方式一：移除插件

删除插件目录或从市场中移除：

```bash
# 从市场移除
codex plugin remove codex-mimocode
```

### 方式二：禁用 MCP 服务器

重命名或删除 `.mcp.json` 以阻止 MCP 服务器启动：

```bash
mv .mcp.json .mcp.json.disabled
```

### 方式三：通过配置禁用

在市场中将插件设为不可用：

```json
{
  "policy": {
    "installation": "NOT_AVAILABLE"
  }
}
```

## 回滚

如果桥接引发问题：

1. **立即操作：** 移除 `.mcp.json` 以停止 MCP 服务器
2. **审计：** 检查 `.codex-mimo/audit.jsonl` 中的最近操作
3. **会话：** 检查 `.codex-mimo/sessions.json` 中的活跃会话
4. **配置：** 移除或重命名 `codex-mimo.config.json` 以恢复默认值

## 配置参考

### `codex-mimo.config.json`

```jsonc
{
  // 覆盖工作区根目录（默认：process.cwd()）
  "workspaceRoot": ".",

  // 文件访问策略
  "fileAccess": {
    "deny": ["**/.env*", "**/id_rsa"]
  },

  // 终端命令策略
  "terminal": {
    "allow": ["git status*", "npm test*"],
    "ask": ["npm install*"],
    "deny": ["git push*", "rm *"]
  },

  // CI 模式：自动拒绝所有 "ask" 决策
  "ci": {
    "enabled": false
  },

  // 审计日志设置
  "audit": {
    "maxFileSize": 10485760,  // 10MB
    "maxFiles": 5
  },

  // MCP 服务器白名单（空 = 允许全部）
  "mcpServers": {
    "allowlist": ["codex-mimocode"]
  }
}
```

## 监控

### 审计日志

位置：`.codex-mimo/audit.jsonl`

事件类型：
- `session_start` — 会话启动
- `permission` — 权限决策（允许/拒绝）
- `file_read` — 文件读取尝试
- `file_write` — 文件写入尝试
- `terminal_create` — 终端命令执行
- `session_end` — 会话结束

### 会话存储

位置：`.codex-mimo/sessions.json`

列出会话：`codex-mimo sessions`

## 故障排查

| 问题 | 操作 |
|-------|--------|
| `mimo not found` | 安装 MiMoCode CLI |
| 权限被拒绝 | 检查 `codex-mimo.config.json` 策略 |
| 审计日志过大 | 调整配置中的 `audit.maxFileSize` |
| MCP 服务器未启动 | 手动运行 `node dist/codex/mcp-server.js` 检查 |
| 会话未找到 | 运行 `codex-mimo sessions` 列出所有会话 |
