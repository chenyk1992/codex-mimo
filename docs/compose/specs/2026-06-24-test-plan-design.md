# [S1] Problem

codex-mimo 有 31 个测试文件，覆盖了核心模块的基本场景，但存在系统性缺口：

| 缺口类别 | 说明 |
|---------|------|
| **MCP 工具层** | `mimoHealthcheck`、`mimoPlan`、`mimoImplement`、`mimoFixCi`、`mimoResume` 无直接单元测试 |
| **Job 生命周期** | 缺少 queued→running→completed/failed 的完整状态转换测试 |
| **ACP Bridge** | 零测试覆盖（`AcpBridge` 的 8 个 handler 方法均未测试） |
| **CLI 命令层** | `cli.test.ts` 存在但覆盖有限 |
| **错误边界** | 文件系统异常、并发访问、进程竞争等边界场景缺失 |
| **Compose 工作流** | 11 个工作流的验证规则（requiresTask/requiresFile/writesAllowed）未系统测试 |

# [S2] Test Architecture

## Mock 策略

- `execa` → mock 所有 `mimo` CLI 调用
- `fs` → 使用 `os.tmpdir()` 创建真实临时目录（当前已有模式）
- `process.kill` / `spawnSync` → DI 注入 mock（已有 `TerminateOptions` 模式）
- ACP 协议 → mock `AcpClient` 的 write/onData

## 测试组织

```
test/unit/
  mcp-tools/           ← 新增：12 个 MCP 工具的独立测试
    mimo-healthcheck.test.ts
    mimo-plan.test.ts
    mimo-implement.test.ts
    mimo-review.test.ts
    mimo-fix-ci.test.ts
    mimo-resume.test.ts
    mimo-compose.test.ts
    mimo-status.test.ts
    mimo-result.test.ts
    mimo-cancel.test.ts
    mimo-jobs.test.ts
    mimo-resume-job.test.ts
  acp/                 ← 新增：ACP Bridge 测试
    acp-bridge.test.ts
    acp-policy.test.ts
  compose/             ← 新增：Compose 工作流验证测试
    workflow-validation.test.ts
    read-only-enforcement.test.ts
  core/                ← 新增：核心模块边界测试
    policy-edge.test.ts
    job-lifecycle.test.ts
    config-loading.test.ts
```

## 覆盖率矩阵（按优先级）

| 优先级 | 模块 | 场景数 | 状态 |
|-------|------|-------|------|
| P0 | mimo_compose (bg) | 15 | 部分覆盖 |
| P0 | Job 生命周期 | 12 | 部分覆盖 |
| P0 | ACP Bridge | 20 | 零覆盖 |
| P1 | mimo_plan/implement/review | 12 | 零覆盖 |
| P1 | Policy 引擎边界 | 10 | 部分覆盖 |
| P1 | Compose 工作流验证 | 11 | 零覆盖 |
| P2 | CLI 命令层 | 16 | 部分覆盖 |
| P2 | Config 加载 | 6 | 零覆盖 |
| P2 | Terminal/Audit | 8 | 零覆盖 |

# [S3] MCP Tools Coverage (12 tools, 48 scenarios)

## mimo_healthcheck

| # | 场景 | 预期 |
|---|------|------|
| 3.1 | `mimo --version` 成功 | `{ok: true, version, cwd}` |
| 3.2 | mimo 未安装 | `{ok: false, error}` |
| 3.3 | cwd 未指定时使用 process.cwd() | cwd 字段正确 |

## mimo_plan

| # | 场景 | 预期 |
|---|------|------|
| 3.4 | 正常 plan 任务 | 返回 summary/sessionId/changedFiles |
| 3.5 | task 为空 | Zod 验证失败 |
| 3.6 | mimo 进程非零退出 | 错误传播 |
| 3.7 | prompt 以 "Objective:" 开头 | 验证 prompt 格式 |

## mimo_implement

| # | 场景 | 预期 |
|---|------|------|
| 3.8 | `allowWrite=false` | 抛异常 "requires allowWrite=true" |
| 3.9 | 正常实现 | 返回 summary + changedFiles（含 worktree diff 新增文件） |
| 3.10 | mimo 进程崩溃 | 错误传播 |
| 3.11 | worktree 无变化 | changedFiles 为空数组 |

## mimo_review

| # | 场景 | 预期 |
|---|------|------|
| 3.12 | 有 diff | 创建临时 .diff 文件，以 `@file` 附件传入 prompt |
| 3.13 | git diff 失败 | 抛 "Git diff capture failed" |
| 3.14 | MiMoCode 返回空输出 | 抛 "produced no review output" |
| 3.15 | 无 diff（"No changes found."） | 不创建临时文件，直接传 prompt |

## mimo_fix_ci

| # | 场景 | 预期 |
|---|------|------|
| 3.16 | 正常 CI 修复 | 返回 changedFiles + commands |
| 3.17 | file 参数缺失 | Zod 验证失败 |
| 3.18 | 自定义 task | 使用自定义 task 而非默认 |

## mimo_resume

| # | 场景 | 预期 |
|---|------|------|
| 3.19 | 正常 resume | 使用 session ID 续接 |
| 3.20 | session 不存在 | mimo 返回错误 |
| 3.21 | task 直接传递 | 验证无 "Objective:" 前缀 |

## mimo_compose (15 scenarios)

| # | 场景 | 预期 |
|---|------|------|
| 3.22 | 前台 dev workflow | 返回 CompactComposeReport |
| 3.23 | 后台模式 | 返回 JobLaunchResult with jobId |
| 3.24 | 后台 worker 崩溃 | onExit 标记 job failed + errorCode "worker_exit" |
| 3.25 | AbortSignal 触发 | 终止 mimo 进程 |
| 3.26 | dryRun | 不执行 mimo，返回 needs_review 报告 |
| 3.27 | workflow 缺少 task | 抛异常 |
| 3.28 | workflow 缺少 file | 抛异常 |
| 3.29 | read-only workflow 修改文件 | status "failed" |
| 3.30 | 语义失败检测 | status "failed" |
| 3.31 | verification 失败 | status "failed" |
| 3.32 | timeout（exitCode=124） | status "timeout" |
| 3.33 | planText 提取 | 从事件中过滤 plan 结构 |
| 3.34 | signal 已 aborted | 立即终止进程 |
| 3.35 | timeoutWarning | 在 kill 前触发回调 |
| 3.36 | 自定义 reportDir | 报告写入指定目录 |

## mimo_status / mimo_result / mimo_cancel / mimo_jobs / mimo_resume_job (12 scenarios)

| # | 场景 | 预期 |
|---|------|------|
| 3.37 | status 查询指定 jobId | 返回该 job 状态 |
| 3.38 | status 无 jobId | 返回最近 job |
| 3.39 | status 无 jobs | 抛 "No jobs recorded" |
| 3.40 | result 有 sessionId | 保存到 SessionStore |
| 3.41 | result 无 jobId | 返回最近已完成 job |
| 3.42 | cancel | 终止进程树 + 标记 cancelled |
| 3.43 | cancel 不存在的 jobId | 抛异常 |
| 3.44 | jobs 列表 | 返回最近 8 个 |
| 3.45 | jobs all=true | 返回全部 |
| 3.46 | resume_job | 创建子 job with parentJobId |
| 3.47 | resume_job parent 无 sessionId | 抛异常 |
| 3.48 | resume_job background | spawn worker |

# [S4] CLI Commands Coverage (8 commands, 20 scenarios)

## healthcheck

| # | 场景 | 预期 |
|---|------|------|
| 4.1 | mimo 可用 | 输出 `{ok: true, version}` JSON |
| 4.2 | mimo 不可用 | 输出 `{ok: false, error}` + exit code 1 |

## plan / implement / review

| # | 场景 | 预期 |
|---|------|------|
| 4.3 | `plan <task>` | 调用 execa with agent "plan", stdin "ignore" |
| 4.4 | `implement <task>` | agent "build" |
| 4.5 | `review` | captureDiff + agent "plan" |
| 4.6 | 缺少 task 参数 | exit code 2 + usage 信息 |
| 4.7 | `--dry-run` | 打印命令但不执行，exit 0 |
| 4.8 | `--json` flag | 输出 JSON 格式 |

## fix-ci

| # | 场景 | 预期 |
|---|------|------|
| 4.9 | `fix-ci --file <path>` | agent "build" + file attachment |
| 4.10 | 缺少 --file | exit code 2 |

## compose

| # | 场景 | 预期 |
|---|------|------|
| 4.11 | `compose --workflow dev <task>` | 调用 runComposeWorkflow |
| 4.12 | `compose --workflow plan <task>` | 传递 plan workflow |
| 4.13 | `--verify "npm test"` | 传递 verification commands |
| 4.14 | `--timeout-ms 60000` | 传递 timeout |
| 4.15 | `--json` | 输出 CompactComposeReport JSON |

## compose-worker

| # | 场景 | 预期 |
|---|------|------|
| 4.16 | `compose-worker --job-id <id>` | 调用 runComposeJobWorker |
| 4.17 | 缺少 --job-id | exit code 2 |

## sessions / resume

| # | 场景 | 预期 |
|---|------|------|
| 4.18 | `sessions` | 输出 JSON 数组 |
| 4.19 | `resume --session <id> <task>` | 使用 session ID 执行 |
| 4.20 | resume session 不存在 | 错误处理 |

# [S5] Core Modules Coverage (44 scenarios)

## Policy Engine (5.1-5.8)

| # | 场景 | 预期 |
|---|------|------|
| 5.1 | 读取 workspace 内文件 | allow |
| 5.2 | 读取 workspace 外文件 | deny |
| 5.3 | 读取 .env 文件 | deny（denied globs） |
| 5.4 | 写入 .npmrc | deny |
| 5.5 | 命令 `git push` | deny |
| 5.6 | 命令 `npm test` | allow |
| 5.7 | 命令 `npm install` | ask |
| 5.8 | CI 模式下 ask | deny |

## Config Loading (5.9-5.12)

| # | 场景 | 预期 |
|---|------|------|
| 5.9 | 正常 config.json | 合并到 policy |
| 5.10 | config 不存在 | 返回空对象，不抛异常 |
| 5.11 | config JSON 格式错误 | 返回空对象 |
| 5.12 | ci.enabled=true | 设置 ciMode |

## Prompt Builders (5.13-5.15)

| # | 场景 | 预期 |
|---|------|------|
| 5.13 | planPrompt | 以 "Objective:" 开头 |
| 5.14 | implementPrompt | 以 "Objective:" 开头 + "Do not ask" |
| 5.15 | reviewPrompt | 包含 diff summary |

## Job Store (5.16-5.23)

| # | 场景 | 预期 |
|---|------|------|
| 5.16 | create | 写入 .json + .log + .events.jsonl + 更新 state.json |
| 5.17 | listJobs | 调用 failStaleJobs 后返回 |
| 5.18 | readJob 不存在 | 返回 undefined |
| 5.19 | updateJob | 保留 immutable 字段（id, kind, cwd, createdAt） |
| 5.20 | state.json 损坏 | rebuildState 从 .json 文件重建 |
| 5.21 | jobId 含路径分隔符 | 拒绝 |
| 5.22 | jobId 为 "state" | 拒绝 |
| 5.23 | prune 超过 maxJobs | 删除最旧 terminal jobs |

## Job Runtime (5.24-5.28)

| # | 场景 | 预期 |
|---|------|------|
| 5.24 | startRuntimeJob | status "running", phase "starting" |
| 5.25 | appendRuntimeEvent | 解析事件、推断 phase、写入 log |
| 5.26 | completeRuntimeJob | status "completed", phase "done" |
| 5.27 | failRuntimeJob | status "failed", phase "failed" |
| 5.28 | 非 active 状态下 append | 静默跳过 |

## Job Phase Inference (5.29-5.33)

| # | 场景 | 预期 |
|---|------|------|
| 5.29 | error event | phase "failed" |
| 5.30 | diff event | phase "editing" |
| 5.31 | tool with edit/write | phase "editing" |
| 5.32 | tool with bash "npm test" | phase "verifying" |
| 5.33 | message event | phase "investigating" |

## Sessions (5.34-5.37)

| # | 场景 | 预期 |
|---|------|------|
| 5.34 | save + get | 持久化正确 |
| 5.35 | save 已存在 sessionId | upsert（更新 lastUsedAt） |
| 5.36 | list | 按 lastUsedAt 降序 |
| 5.37 | remove | 删除并持久化 |

## Terminal Manager (5.38-5.41)

| # | 场景 | 预期 |
|---|------|------|
| 5.38 | create | 返回 terminal with id |
| 5.39 | get 不存在 | 返回 undefined |
| 5.40 | waitForExit 超时 | reject |
| 5.41 | kill + release | 进程终止 |

## Audit Logger (5.42-5.44)

| # | 场景 | 预期 |
|---|------|------|
| 5.42 | log | 追加 JSONL 行 |
| 5.43 | 文件大小超限 | rotation |
| 5.44 | cleanup | 删除超出 maxFiles 的旧文件 |

# [S6] Compose Workflows Coverage (18 scenarios)

## Workflow Validation (6.1-6.6)

| # | 场景 | 预期 |
|---|------|------|
| 6.1 | brainstorm | requiresTask=true, writesAllowed=false |
| 6.2 | dev | requiresTask=true, writesAllowed=true |
| 6.3 | fix-ci | requiresFile=true, requiresTask=false |
| 6.4 | review | requiresTask=false, requiresFile=false |
| 6.5 | plan | requiresTask=true, writesAllowed=false |
| 6.6 | execute-plan | requiresFile=true, writesAllowed=true |

## Read-only Enforcement (6.7-6.9)

| # | 场景 | 预期 |
|---|------|------|
| 6.7 | brainstorm 修改文件 | failed + "Read-only workflow brainstorm modified files" |
| 6.8 | plan 创建 untracked 文件 | failed |
| 6.9 | dev 修改文件 | allowed（writesAllowed=true） |

## Semantic Failure Detection (6.10-6.14)

| # | 场景 | 预期 |
|---|------|------|
| 6.10 | "What would you like me to help?" | failed |
| 6.11 | "How can I help you?" | failed |
| 6.12 | "It looks like your message got cut off" | failed |
| 6.13 | 正常代码分析消息（含 ```） | 不误判 |
| 6.14 | 长消息（>500 字符） | 不误判 |

## Default Verification (6.15-6.18)

| # | 场景 | 预期 |
|---|------|------|
| 6.15 | dev workflow | defaultVerification ["npm test"] |
| 6.16 | brainstorm workflow | 无 defaultVerification |
| 6.17 | 自定义 verification 覆盖 default | 使用自定义 |
| 6.18 | verification 全部 passed | status "passed" |

# [S7] ACP Bridge Coverage (20 scenarios)

## Protocol Lifecycle (7.1-7.4)

| # | 场景 | 预期 |
|---|------|------|
| 7.1 | `AcpBridge.run(task)` 完整流程 | initialize → session/new → session/prompt |
| 7.2 | initialize 返回错误 | 清理进程 + 抛异常 |
| 7.3 | session/new 返回 sessionId | 存储到 bridge 状态 |
| 7.4 | session/prompt 返回 stopReason | 包含在 result 中 |

## Agent Request Handlers (7.5-7.12)

| # | 场景 | 预期 |
|---|------|------|
| 7.5 | `fs/read_text_file` workspace 内 | 返回 content |
| 7.6 | `fs/read_text_file` workspace 外 | 返回 error "Read denied by policy" |
| 7.7 | `fs/read_text_file` 文件不存在 | 返回 error "Failed to read file" |
| 7.8 | `fs/write_text_file` 允许 | 写入文件 + 返回 null |
| 7.9 | `fs/write_text_file` 被策略拒绝 | 返回 error "Write denied by policy" |
| 7.10 | `terminal/create` 允许命令 | 返回 terminalId |
| 7.11 | `terminal/create` 被拒绝命令 | 返回 error "Command denied by policy" |
| 7.12 | `session/request_permission` | 根据 decideCommand 返回 allow/cancel |

## Terminal Management (7.13-7.17)

| # | 场景 | 预期 |
|---|------|------|
| 7.13 | `terminal/output` | 返回 stdout + stderr 合并 |
| 7.14 | `terminal/output` 不存在的 terminalId | 返回 exitStatus -1 |
| 7.15 | `terminal/wait_for_exit` 正常退出 | 返回 exitStatus |
| 7.16 | `terminal/wait_for_exit` 超时 | reject |
| 7.17 | `terminal/kill` + `terminal/release` | 终止进程 |

## Policy Enforcement (7.18-7.20)

| # | 场景 | 预期 |
|---|------|------|
| 7.18 | CI 模式下所有 ask | deny |
| 7.19 | denied 命令（rm, git push） | deny |
| 7.20 | 审计日志记录 | 所有 permission/file/terminal 操作被记录 |

# [S8] Cross-cutting Concerns (16 scenarios)

## Error Propagation (8.1-8.4)

| # | 场景 | 预期 |
|---|------|------|
| 8.1 | mimo CLI 不存在（ENOENT） | 工具层返回有意义错误 |
| 8.2 | mimo CLI 超时 | exitCode 124 + status "timeout" |
| 8.3 | 磁盘满（writeFileSync 失败） | 错误不被吞没 |
| 8.4 | 网络中断 | 错误传播到 summary |

## Process Management (8.5-8.8)

| # | 场景 | 预期 |
|---|------|------|
| 8.5 | terminateProcessTree Windows | taskkill /PID /T /F |
| 8.6 | terminateProcessTree Unix | 先 SIGTERM process group，再 SIGKILL |
| 8.7 | 进程已退出 | terminateProcessTree 不抛异常 |
| 8.8 | shell: true 下的子进程存活 | 验证 kill 后 isProcessAlive 检测 |

## Concurrent Access (8.9-8.11)

| # | 场景 | 预期 |
|---|------|------|
| 8.9 | 两个 compose 同时写 state.json | 不损坏 |
| 8.10 | 同一 jobId 并发 updateJob | 最后写入胜出 |
| 8.11 | listJobs + createJob 并发 | 不丢失 job |

## Job Stale Detection (8.12-8.13)

| # | 场景 | 预期 |
|---|------|------|
| 8.12 | queued 超过 5 分钟 | failStaleJobs 自动标记 failed |
| 8.13 | running 状态 job | 不被 failStaleJobs 影响 |

## File System Edge Cases (8.14-8.16)

| # | 场景 | 预期 |
|---|------|------|
| 8.14 | .codex-mimo 目录不存在 | 自动创建 |
| 8.15 | 路径含空格/特殊字符 | 正确处理 |
| 8.16 | Windows 长路径（>260 字符） | normalizePath 正确处理 |

# [S9] Issue Discovery Template

每个发现的问题应记录以下信息：

```markdown
## Issue #N: <简短标题>

**表象**: 用户可见的错误行为描述
**原因**: 代码层面的根因分析
**影响范围**: 哪些场景/工具受影响
**严重程度**: P0 (阻断) / P1 (功能缺失) / P2 (边界) / P3 (优化)
**相关代码**: `src/path/to/file.ts:line`
**复现步骤**: 最小复现路径
**建议修复方向**: 概述（不展开实现细节）
```

# [S9.1] Discovered Issues

## Issue #1: AuditLogger.close() 不等待流刷新

**表象**: 调用 `close()` 后立即读取 audit.jsonl 文件会抛 ENOENT 错误
**原因**: `close()` 调用 `this.stream.end()` 但不等待流完成写入。WriteStream 是异步的，`end()` 返回时数据可能还未刷新到磁盘
**影响范围**: AcpBridge.cleanup() 中的审计日志关闭，任何在 close() 后立即读取审计日志的场景
**严重程度**: P1 (功能缺失)
**相关代码**: `src/core/audit.ts:46-48`
**复现步骤**: 创建 AuditLogger → log() → close() → readFileSync(audit.jsonl) → ENOENT
**建议修复方向**: 将 close() 改为返回 Promise，在 stream 'finish' 事件中 resolve

**状态**: ✅ 已修复（close() 改为 async）

## Issue #2: TerminalManager 测试使用 Unix-only 命令

**表象**: `test/unit/core/terminal-manager.test.ts` 中的 `sleep 10` 命令在 Windows 上不存在，导致测试失败
**原因**: 测试使用了 Unix 特有的 `sleep` 命令，未做跨平台兼容
**影响范围**: Windows 环境下的测试执行
**严重程度**: P2 (边界)
**相关代码**: `test/unit/core/terminal-manager.test.ts:22-23`
**复现步骤**: 在 Windows 上运行 `npx vitest run test/unit/core/terminal-manager.test.ts`
**建议修复方向**: 使用 `node -e "setTimeout(() => {}, 10000)"` 替代 `sleep 10`

**状态**: ✅ 已修复

## Issue #3: ACP Bridge nonInteractive 模式将所有 "ask" 转为 "deny"

**表象**: AcpBridge 构造函数设置 `nonInteractive: true`，导致所有 "ask" 决策被转为 "deny"
**原因**: `configToPolicy()` 中 `nonInteractive` 标志会将 `resolveDecision(policy, "ask")` 转为 "deny"
**影响范围**: ACP 路径下所有需要用户确认的命令（如 `npm install`）会被拒绝
**严重程度**: P2 (设计决策，非 bug)
**相关代码**: `src/mimo/acp-bridge.ts:56`
**复现步骤**: 通过 ACP bridge 执行 `npm install` → 被拒绝
**建议修复方向**: 这是安全设计。如果需要允许特定命令，应在 policy 配置中显式添加到 allowedCommands

## Issue #4: reviewPrompt 不使用 "Objective:" 前缀

**表象**: `reviewPrompt()` 以 "You are being invoked by Codex as a specialist MiMoCode review agent." 开头，而非 "Objective:"
**原因**: review 接收的是 diff 内容而非任务描述，最初设计时未使用 Objective 格式
**影响范围**: mimo_review 工具的 prompt 格式，可能导致 MiMoCode 进入交互澄清模式
**严重程度**: P3 (优化)
**相关代码**: `src/core/prompt.ts`
**复现步骤**: 调用 reviewPrompt("diff content") → 不以 "Objective:" 开头
**建议修复方向**: 统一使用 "Objective:" 前缀，任务描述为 "Review the following diff..."

**状态**: ✅ 已修复（reviewPrompt 现在以 "Objective:" 开头，与 planPrompt/implementPrompt 格式一致）

## Issue #5: captureWorktreeFiles 吞没错误

**表象**: `captureWorktreeFiles()` 在 git status 失败时返回空 Set，不抛异常
**原因**: 函数使用 `try/catch` 包裹 execa 调用，catch 块返回空 Set
**影响范围**: mimo_implement, mimo_resume, mimo_fix_ci 中的 changedFiles 计算
**严重程度**: P2 (边界)
**相关代码**: `src/codex/tools.ts:322-339`
**复现步骤**: 在非 git 仓库中调用 mimo_implement → changedFiles 可能不完整
**建议修复方向**: 返回 undefined，让调用方决定如何处理

**状态**: ✅ 已修复（返回 undefined，diffAddedFiles 处理 undefined 输入返回空数组）

## Issue #6: writeReviewDiffInput 在 cwd 内创建临时文件

**表象**: mimo_review 创建的 .diff 文件位于 `.codex-mimo/review-inputs/` 目录下（项目 cwd 内）
**原因**: 使用 `path.join(cwd, ".codex-mimo", "review-inputs")` 作为目录
**影响范围**: mimo_review 工具会在项目目录中创建临时文件
**严重程度**: P3 (优化)
**相关代码**: `src/codex/tools.ts:125-132`
**复现步骤**: 调用 mimo_review → 在项目 .codex-mimo/review-inputs/ 下创建 .diff 文件
**建议修复方向**: 使用 os.tmpdir() 存放临时文件

**状态**: ✅ 已修复（改为使用 os.tmpdir()/codex-mimo-review-inputs/）

## Issue #7: AcpClient handleAgentRequest 是 fire-and-forget

**表象**: AcpClient 的 agent request handler 是异步的，但调用方不等待结果
**原因**: ACP 协议中 agent request 的响应可能在 bridge.run() 返回后才到达
**影响范围**: ACP 路径下的测试需要特殊处理（使用 vi.waitFor 轮询）
**严重程度**: P3 (测试挑战，非运行时问题)
**相关代码**: `src/mimo/acp-client.ts`
**复现步骤**: 在测试中验证 agent request 响应时需要轮询
**建议修复方向**: 在 AcpClient 中跟踪 pending agent requests，提供 waitForPendingAgentRequests() 方法

**状态**: ✅ 已修复（AcpClient 添加 pendingAgentRequests 跟踪 + waitForPendingAgentRequests()，bridge.run() 在返回前等待所有 pending 请求完成）

## Issue #8: Windows 进程清理导致 EPERM

**表象**: TerminalManager 测试在 Windows 上 spawn 真实进程后，temp 目录清理时抛 EPERM
**原因**: Windows 上进程可能持有文件句柄，导致目录删除失败
**影响范围**: 涉及 TerminalManager 的测试
**严重程度**: P2 (边界)
**相关代码**: `src/core/terminal.ts`
**复现步骤**: 在 Windows 上运行 TerminalManager 测试 → afterEach 清理可能失败
**建议修复方向**: 添加 releaseAsync() 方法等待进程完全退出后再删除

**状态**: ✅ 已修复（TerminalManager 添加 releaseAsync() 方法，AcpBridge.cleanup() 使用 releaseAsync 确保进程退出后再清理）

# [S10] Summary

| 子系统 | 计划场景数 | 实际测试数 | 状态 |
|--------|----------|----------|------|
| MCP Tools | 48 | 40 | ✅ 全部通过 |
| CLI Commands | 20 | 24 | ✅ 全部通过 |
| Core Modules | 44 | 36 | ✅ 全部通过 |
| Compose Workflows | 18 | 18 | ✅ 全部通过 |
| ACP Bridge | 20 | 20 | ✅ 全部通过 |
| Cross-cutting | 16 | 20 | ✅ 全部通过 |
| **总计** | **166** | **158** | ✅ |

**测试套件**: 60 个测试文件, 363 个测试, 全部通过
**类型检查**: tsc --noEmit 通过
**发现 Issue**: 8 个 (6 个已修复, 1 个设计决策跳过, 1 个设计决策已解决)
