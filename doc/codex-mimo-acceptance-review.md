# Codex-MiMo 验收与代码审查

日期：2026-06-21

审查项目：`E:\ideaProjects\codex-mimo`

## 验证摘要

在 `E:\ideaProjects\codex-mimo` 中执行了全新的验证命令：

```text
npm run build
```

结果：通过。TypeScript 编译完成，退出码为 0。

```text
npm test
```

结果：通过。Vitest 报告 4 个测试文件通过，22 个测试用例通过。

审查时的 Git 状态：

```text
?? .idea/vcs.xml
```

未跟踪的 `.idea/vcs.xml` 看起来是 IDE 元数据，未纳入实现审查范围。

## 发现问题

### P0：ACP 协议类型与 ACP v1 规范不匹配，`mimo acp` 桥接无法与真实 ACP 代理互通

涉及文件：

- `E:\ideaProjects\codex-mimo\src\mimo\acp-types.ts:40`
- `E:\ideaProjects\codex-mimo\src\mimo\acp-types.ts:75`
- `E:\ideaProjects\codex-mimo\src\mimo\acp-types.ts:83`
- `E:\ideaProjects\codex-mimo\src\mimo\acp-types.ts:109`
- `E:\ideaProjects\codex-mimo\src\mimo\acp-types.ts:113`
- `E:\ideaProjects\codex-mimo\src\mimo\acp-types.ts:128`

本地 ACP 类型与 ACP v1 不一致。最重要的不匹配项包括：

- `InitializeResult` 使用 `capabilities` 和 `serverInfo`，而 ACP v1 返回 `agentCapabilities`、`agentInfo` 和 `authMethods`。
- `SessionUpdate` 期望本地变体如 `{ type: "message" }`、`{ type: "tool" }` 和 `{ type: "usage" }`，而 ACP v1 使用 `update.sessionUpdate` 鉴别器，如 `agent_message_chunk`、`tool_call`、`tool_call_update`、`plan` 和 `usage_update`。
- `RequestPermissionParams` 期望 `operation` 和 `details`，而 ACP v1 发送 `toolCall` 和 `options`。
- `RequestPermissionResult` 返回 `{ outcome: "allow" | "deny" }`，而 ACP v1 期望 `{ outcome: { outcome: "selected", optionId } }` 或 `{ outcome: { outcome: "cancelled" } }`。
- `WriteTextFileResult` 返回 `{ bytes }`，而 ACP v1 的 `fs/write_text_file` 成功时返回 `result: null`。
- `TerminalCreateParams` 缺少 `args`、`env` 和 `outputByteLimit`，`TerminalOutputResult` 返回 `stdout/stderr/exitCode`，而 ACP v1 期望 `output`、`truncated` 和 `exitStatus`。

影响：

TypeScript 构建通过是因为实现内部自洽，但它符合的是本地协议而非 ACP v1。真实的 `mimo acp` 进程可能会拒绝响应、无法解析权限结果、丢失更新，或无法正确执行终端请求。

建议修复：

将 `src/mimo/acp-types.ts` 替换为兼容 ACP v1 的请求/结果/更新类型，然后更新 `acp-bridge.ts` 和 `acp-updates.ts` 以将真实 ACP 消息转换为 `CodexMimoEvent`。

添加基于固定数据的测试，使用真实 ACP 格式的消息：

```json
{
  "sessionUpdate": "agent_message_chunk",
  "messageId": "msg_1",
  "content": { "type": "text", "text": "hello" }
}
```

```json
{
  "sessionUpdate": "tool_call",
  "toolCallId": "call_1",
  "title": "Running tests",
  "kind": "execute",
  "status": "pending"
}
```

### P0：终端命令处理丢失 ACP `args` 参数，仅验证命令名，导致策略绕过和命令执行异常

涉及文件：

- `E:\ideaProjects\codex-mimo\src\mimo\acp-types.ts:113`
- `E:\ideaProjects\codex-mimo\src\mimo\acp-bridge.ts`
- `E:\ideaProjects\codex-mimo\src\core\terminal.ts`

ACP 终端请求分别携带 `command` 和 `args`。桥接层当前仅建模 `command`，然后仅将该值传递给 `TerminalManager.create`。这意味着等价于 `npm test -- session.test.ts` 的请求变成了 `npm`，危险请求也可能因策略检查看不到参数而被错误分类。

影响：

安全命令可能因参数丢失而失败。危险命令可能因策略评估不完整输入而被错误允许或拒绝。这同时破坏了功能和安全模型。

建议修复：

将终端请求表示为：

```ts
interface TerminalCreateParams {
  sessionId: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  cwd?: string;
  outputByteLimit?: number;
}
```

从 `command` 加安全引用的 `args` 构建策略字符串，并在可能时不通过 shell 插值生成进程：

```ts
spawn(command, args ?? [], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
```

添加以下测试：

- `npm test -- session.test.ts` 被允许并带参数执行。
- `git push origin main` 在表示为 `command: "git", args: ["push", "origin", "main"]` 时被拒绝。
- `rm -rf dist` 在表示为 `command: "rm", args: ["-rf", "dist"]` 时被拒绝。

### P1：ACP 桥接中 `ask` 决策被静默转换为允许

涉及文件：

- `E:\ideaProjects\codex-mimo\src\mimo\acp-bridge.ts`
- `E:\ideaProjects\codex-mimo\src\core\policy.ts`

策略层可返回 `allow`、`ask` 或 `deny`，但 `handlePermissionRequest`、`handleFileWrite` 和 `handleTerminalCreate` 将所有非 `deny` 结果视为可执行。这意味着本应需要确认的命令（如安装或构建）可在非 CI 模式下自动运行。

影响：

文档化的安全模型说明包安装和普通写入需要审批，但 ACP 桥接实际上自动批准了它们。对于一个主要职责是安全委派代码变更的工具来说，这是安全和信任问题。

建议修复：

定义桥接模式：

- 非交互模式：`ask` 变为 `deny`。
- 交互模式：`ask` 调用审批回调并返回选中的 ACP 权限选项。
- CI 模式：`ask` 变为 `deny`。

为所有三种结果添加测试。

### P1：CLI 参数已解析但未应用，文档中的 MVP 控制项不生效

涉及文件：

- `E:\ideaProjects\codex-mimo\src\cli\main.ts`

CLI 解析了 `--file`、`--dry-run`、`--json` 和 `--ci`，但当前命令执行未使用这些值。提取的变量未传递给 `runPlan`、`runImplement`、`runReview`、`mimo run` 或策略层。

影响：

用户可以传递看似受支持但实际无效的参数。这对 `--dry-run` 和 `--ci` 尤其危险，因为用户可能期望这些参数能阻止执行或加强权限。

建议修复：

要么在实现前从 CLI 中移除不支持的参数，要么将它们接入：

- `--dry-run`：打印确切的 `mimo` 命令后退出，不执行。
- `--json`：返回结构化包装输出，而非仅继承 stdout。
- `--file`：将附加文件传入 `buildMimoRunArgs`。
- `--ci`：以 CI 模式加载策略，拒绝所有 `ask` 操作。

添加 CLI 测试，使用 `--dry-run` 生成 `dist/cli/main.js` 并断言未执行 `mimo` 进程。

### P1：MCP 工具返回空或通用结果，未解析 MiMoCode 输出或 diff 状态

涉及文件：

- `E:\ideaProjects\codex-mimo\src\codex\tools.ts`

`mimoPlan`、`mimoImplement`、`mimoReview`、`mimoFixCi` 和 `mimoResume` 等工具执行了 MiMoCode 但返回静态占位符，如 `changedFiles: []`、`verification: []`、`findings: []` 或 `"Review completed."`。

影响：

Codex 无法从 MCP 工具结果中可靠地检查 MiMoCode 变更了什么或产生了什么审查发现。这削弱了预期的编排模型——即 Codex 委派工作然后验证。

建议修复：

捕获并解析 `mimo run --format json` 输出，而非直接继承 stdout。至少收集：

- 会话 ID（如存在）
- 文本摘要
- 工具调用
- `git diff --name-only` 获取的变更文件
- 已执行的命令
- 错误或停止原因

对于审查，返回解析后的发现或原始审查文本，而非空的 findings 数组。

### P1：配置文件访问规则被部分忽略

涉及文件：

- `E:\ideaProjects\codex-mimo\src\core\config.ts`

`ConfigFile.fileAccess` 支持 `read`、`write` 和 `deny`，但 `configToPolicy` 仅应用 `deny`。`read` 和 `write` 白名单未体现在 `BridgePolicy` 中，因此用户无法通过配置缩小读/写访问范围，尽管配置架构暗示可以。

影响：

文档化的策略模型比实际实现更严格。用户可能认为已将桥接访问限制在子目录，而默认的工作区范围行为仍然生效。

建议修复：

扩展 `BridgePolicy`，添加显式的读和写白名单，在 `decideFileRead` 和 `decideFileWrite` 中应用它们，并测试配置的子目录白名单能阻止同级路径访问。

### P2：测试覆盖验证了本地抽象，但未验证真实的集成契约

涉及文件：

- `E:\ideaProjects\codex-mimo\test\unit\acp-client.test.ts`
- `E:\ideaProjects\codex-mimo\test\unit\acp-updates.test.ts`
- `E:\ideaProjects\codex-mimo\test\unit\policy.test.ts`

当前测试有用，但大多断言的是实现的本地形状。它们无法捕获 ACP 规范不匹配、被忽略的 CLI 参数、终端参数丢失或 MCP 占位符响应。

影响：

构建和测试可以通过，而桥接层仍与真实 MiMoCode ACP 行为不兼容。

建议修复：

在三个层面添加测试：

- ACP 固定数据：解析并响应真实的 ACP v1 消息。
- CLI 行为：dry-run、文件附加、JSON 输出和 CI 模式。
- MCP 工具行为：验证变更文件和审查结果从工具调用中返回。

## 验收清单

| 需求 | 状态 | 备注 |
| --- | --- | --- |
| TypeScript 项目构建 | 通过 | `npm run build` 退出码 0 |
| 单元测试通过 | 通过 | 22 个测试通过 |
| 脚本 MVP 存在 | 部分 | `plan`、`implement`、`review`、`healthcheck`、`sessions`、`resume` 已存在 |
| Codex 插件清单存在 | 通过 | `.codex-plugin/plugin.json` 存在 |
| MCP 服务器存在 | 通过 | `src/codex/mcp-server.ts` 存在 |
| ACP 桥接存在 | 部分 | 存在，但 ACP 类型与 ACP v1 不匹配 |
| 安全默认策略存在 | 部分 | 策略存在，但桥接中 `ask` 被自动允许，配置白名单被忽略 |
| MiMoCode 输出解析为工具结果 | 部分 | 工具执行 MiMoCode 但返回占位符 |
| 会话持久化已实现 | 部分 | `SessionStore` 存在，但审查代码未发现从 run/ACP 流程保存新会话 ID |
| 文档存在 | 通过 | README 和文档存在 |

## 建议修复顺序

1. 在投入更多 ACP 行为之前，先对齐 ACP 类型和响应与 ACP v1。
2. 修复终端 `command + args` 处理和策略评估。
3. 使 `ask` 确定性：在非交互/CI 模式下拒绝，仅通过显式回调批准。
4. 接入或移除已解析的 CLI 参数。
5. 解析 `mimo run --format json` 并返回真实的 MCP 工具结果。
6. 为 ACP 和 CLI 行为添加基于固定数据的集成测试。

## 总体评估

项目有坚实的骨架，通过了当前的构建/测试套件。MVP 方向清晰可辨，代码库组织方式使其易于加固。

主要阻塞点是 ACP 桥接当前实现的是 ACP 的本地近似，而非文档中所述的 ACP v1。在协议类型、终端处理、权限结果和工具结果解析被修正之前，我不建议将 ACP/插件路径视为生产就绪。
