# Host Companion Hooks 设计

**日期：** 2026-07-20  
**状态：** 已批准（试用版）  
**范围：** 跨宿主（Cursor / Claude Code / OpenCode / Codex CLI）在后台 MiMo job 需要关注时，把回执续回原会话

## 背景

codex-mimo 工作工具立即返回 `queued` receipt；真正执行在后台 worker。对外通知目前只有：

- `notify: { type: "codex" }`（依赖 `CODEX_THREAD_ID` + App Server）
- `notify: { type: "webhook" }`（HTTP 推送）

Cursor / Claude Code / OpenCode 等宿主通常没有 Codex 式 thread resume。它们普遍支持 **lifecycle hooks**（宿主事件 → 跑本地脚本），但 **不能** 被外部 MiMo worker 反向调用。

## 目标

1. 用户不必在原会话里手动追问 job 结果。
2. 同一套 attention 语义适用多宿主：`needs_input` / `blocked` / 终态。
3. 先交付 **Cursor 试用版**；其它宿主以同一 watch/ack 契约加薄适配。
4. 不改变现有 Codex Desktop adapter；不把飞书/邮件当成默认路径。

## 非目标（本迭代）

- 不为 Claude Code / OpenCode / Codex CLI 先写完整适配（只定义契约与 Cursor 实现）。
- 不改为同步阻塞 MCP。
- 不新增第三种 `notify.type`（companion 读 job 记录 + 本地 watch，不依赖 outbox 必须有 target）。
- 不保证会话已关闭后的跨进程硬唤醒（下次 `sessionStart` / 新轮次可再扫）。

## 控制流

```text
宿主 Agent 调用 mimo_* work MCP
  → afterMCP companion：解析 receipt.jobId + cwd，写入本地 watch 表
  → 立即返回 queued（现有行为）

后台 job worker 跑到 attention（终态 / needs_input / blocked）
  → 写 .codex-mimo/jobs/<id>.json + signals（现有行为）

宿主 Agent 本轮 stop
  → stop companion：查 watch 表对应 job
      · 仍 queued/running → followup：请调 mimo_status / mimo_wait，勿编造结果
      · attention 且未 ack → followup：请调 mimo_result 并向用户汇报，然后 ack
      · 已 ack / 无 watch → {}
```

要点：**宿主主动拉** = companion hook 拉，不是用户手动问。

## 本地契约

全局 watch 注册（跨「Cursor 打开的 repo」与「job cwd」不一致的情况）：

`~/.codex-mimo/companion-watch.json`

```ts
interface CompanionWatchState {
  version: 1;
  watches: Array<{
    cwd: string;
    jobId: string;
    kind?: string;
    createdAt: string;
    conversationId?: string;
  }>;
  acked: Record<string, { status: string; ackedAt: string }>; // key = `${cwd}::${jobId}`
}
```

Attention 状态：`needs_input` | `blocked` | `completed` | `failed` | `cancelled` | `timeout`  
Active 状态：`queued` | `running`

## Cursor 适配

| Hook | 作用 |
|------|------|
| `afterMCPExecution` | 匹配 `mimo_plan` / `mimo_implement` / `mimo_review` / `mimo_fix_ci` / `mimo_resume` / `mimo_compose`；从 `result_json` 取 `jobId`，从 `tool_input` 取 `cwd`，登记 watch |
| `stop` | 扫描 watch；必要时返回 `followup_message`；`loop_limit` 覆盖轮询等待 |

脚本：`hosts/cursor/mimo-companion.mjs`（Node，Windows 友好）  
安装：项目级 `.cursor/hooks.json` 或用户级 `~/.cursor/hooks.json`

## 其它宿主（后续）

| 宿主 | 建议事件 | 续会话手段 |
|------|----------|------------|
| Claude Code | `PostToolUse`（登记）+ `Stop`（拉取） | `additionalContext` / block-stop 续轮 |
| OpenCode | `tool.execute.after` + `session.idle` | plugin 注入 prompt / toast + 续聊 |
| Codex CLI | `PostToolUse` + `Stop` | Stop `decision: block` 或 context 注入 |

共用同一 `companion-watch.json` 契约。

## 失败与安全

- Hook 失败默认 fail-open（不影响 Agent）。
- `aborted` stop 不发 followup。
- followup 文案只含 `jobId` / `cwd` / `status`，不含密钥与完整 prompt。
- ack 防止同一终态反复续聊；active 轮询受 `loop_limit` 约束。

## 试用验收

1. 在已配置 Cursor hooks 的工作区调用 `mimo_plan`（cwd 为合法 git 仓库）。
2. Agent 停一轮后，无需用户追问，应自动出现 followup 去查 status/result。
3. job 进入终态后，应自动出现 followup 要求 `mimo_result` 并向用户汇报。
4. 再次 stop 不应对同一 job 重复刷屏。
