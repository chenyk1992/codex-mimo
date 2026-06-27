# Codex MiMoCode Bridge

A bridge that lets Codex invoke MiMoCode as a specialist coding agent for planning, implementation, and review.

## Prerequisites

MiMoCode must be installed and authenticated:

```bash
mimo --version
mimo auth list
```

## Setup

```bash
npm install
npm run build
```

## CLI Usage (MVP)

```bash
codex-mimo plan "Add login rate limiting"
codex-mimo implement "Fix failing user-session test"
codex-mimo review
codex-mimo healthcheck
```

## Compose Workflow Launcher

Use `codex-mimo compose` when you want MiMoCode to run a skill-driven workflow:

```bash
codex-mimo compose --workflow dev "Implement login throttling"
codex-mimo compose --workflow fix-ci --file ci.log
codex-mimo compose --workflow execute-plan --file doc/codex-mimo-acp-integration-plan.md
codex-mimo compose --workflow review --since HEAD
codex-mimo compose --workflow plan --timeout-ms 110000 "Create a validation plan"
```

Reports are written to:

```text
.codex-mimo/reports/
.codex-mimo/events/
```

Each report includes MiMoCode JSON events, changed files, diff stat, verification command results, and review text.

When a caller has its own timeout, pass `--timeout-ms` lower than the outer timeout so `codex-mimo` can stop MiMoCode and write a report instead of leaving a child process running.

## Codex Plugin Installation

The project is packaged as a Codex plugin. To install:

1. Build the project: `npm run build`
2. The plugin is at the project root with:
   - `.codex-plugin/plugin.json` - plugin manifest
   - `.mcp.json` - MCP server configuration
   - `skills/mimocode/SKILL.md` - skill describing when/how to use MiMoCode

The MCP server exposes these tools to Codex:

| Tool | Description |
|------|-------------|
| `mimo_healthcheck` | Check MiMoCode installation and auth state |
| `mimo_plan` | Create implementation plans without editing files |
| `mimo_implement` | Implement code changes with surgical precision |
| `mimo_review` | Review current diff for bugs and regressions |
| `mimo_fix_ci` | Fix CI failures using a log file |
| `mimo_resume` | Resume a previous MiMoCode session |
| `mimo_compose` | Run a MiMoCode Compose workflow and return a structured report |

If the installed plugin cache fails with `ERR_MODULE_NOT_FOUND`, the cache is missing runtime dependencies. Reinstall dependencies in the plugin root or use a bundled plugin build; `dist/` alone is not enough for the current NodeNext build.

### Long-Running Jobs

For long Compose workflows, pass `background: true` to receive a `jobId` immediately. Use `mimo_status` for progress, `mimo_result` for final output, and `mimo_cancel` to stop active work. Full artifacts are persisted under `.codex-mimo/`.

## Safety Model

- Writes outside workspace: **denied**
- Secret file reads (.env, keys): **denied**
- Destructive commands (rm, git push, git reset): **denied**
- Test/lint/typecheck commands: **allowed**
- Package install commands: **ask**

See `doc/policy-guide.md` for the full policy specification.

## Architecture

```
Codex -> MCP Server -> CLI Commands -> mimo run/ACP -> MiMoCode
                                    ^
                              Policy Layer
                              Audit Log
```

## Project Structure

```
src/
  cli/          CLI entry point and commands
  core/         Policy, paths, audit, terminal management
  mimo/         ACP client, bridge, process supervisor
  codex/        MCP server and tool definitions
templates/      MiMoCode configuration templates
skills/         Codex skill definitions
doc/            Documentation
```

## Configuration

Copy `templates/mimocode.jsonc` to your project root and customize as needed.

---

## Usage Manual: Vibe Coding with Codex + MiMoCode

本手册以程序员接到新需求到编码测试的完整流程为示范，展示如何在 Codex 中使用 codex-mimo 进行 vibe coding。

### 前置条件

确保 MiMoCode 已安装并认证：

```bash
mimo --version      # 确认版本 >= 0.1.3
mimo auth list      # 确认已登录
```

在 Codex 中确认插件可用：

```
帮我检查 MiMoCode 是否可用
```

Codex 会调用 `mimo_healthcheck`，返回 `{ "ok": true, "version": "0.1.3" }` 即表示就绪。

---

### 场景一：接到新需求 — 从分析到实现

假设你接到一个需求：**"给用户登录接口添加速率限制，防止暴力破解"**

#### 第 1 步：需求澄清（Brainstorm）

如果需求比较模糊，先用 `brainstorm` 工作流澄清：

```
我需要给登录接口加速率限制，帮我分析一下需求和实现方向
```

Codex 会调用 `mimo_compose(workflow: "brainstorm", task: "...")`，MiMoCode 会：
- 分析项目现有的认证模块结构
- 提出关键问题（用什么算法？限制粒度？存储方式？）
- 给出初步建议

#### 第 2 步：生成实施计划（Plan）

需求明确后，生成实施计划：

```
根据以下需求生成实施计划：
- 登录接口每分钟最多 5 次尝试
- 基于 IP 地址限流
- 超限返回 429 状态码
- 需要单元测试覆盖
```

Codex 会调用 `mimo_plan` 或 `mimo_compose(workflow: "plan")`，返回：
- 涉及的文件列表
- 实施步骤
- 风险点
- 验证命令

计划会写入 `.codex-mimo/reports/` 目录。

#### 第 3 步：执行实现（Implement / Dev）

**方式 A：使用 Compose dev 工作流（推荐）**

对于完整的功能开发，使用 `dev` 工作流，它会自动执行 brainstorm → plan → tdd → verify → review 全流程：

```
按照计划实现登录速率限制功能：
- 使用 sliding window 算法
- 基于 IP 地址限流
- 超限返回 429
- 包含单元测试
```

Codex 会调用 `mimo_compose(workflow: "dev", task: "...")`。

**方式 B：使用 implement 直接实现（适合小改动）**

如果改动范围小且明确，可以直接实现：

```
在 src/middleware/ 下添加 rate-limit.ts，实现登录速率限制中间件
```

Codex 会调用 `mimo_implement(task: "...", allowWrite: true)`。

#### 第 4 步：查看结果

实现完成后，Codex 会展示：
- **变更文件列表** — MiMoCode 修改了哪些文件
- **验证结果** — 测试是否通过
- **摘要** — 做了什么、还剩什么风险

如果状态是 `needs_review`，说明需要人工审查。

#### 第 5 步：代码审查（Review）

对变更进行审查：

```
帮我 review 一下刚才的改动
```

Codex 会调用 `mimo_review` 或 `mimo_compose(workflow: "review")`，返回：
- 正确性问题
- 安全隐患
- 缺失的测试覆盖
- 建议改进

#### 第 6 步：提交前验证

在 Codex 中运行验证：

```
运行测试和类型检查，确认改动没有引入问题
```

Codex 会执行 `npm test` 和 `npm run lint`（或项目对应的验证命令）。

---

### 场景二：修复 Bug

#### 简单 Bug

```
src/auth/login.ts 第 42 行的密码比较没有做 timing-safe 处理，有时间攻击风险，帮我修复
```

Codex 调用 `mimo_implement` 直接修复。

#### 复杂 Bug（需要调试）

```
用户报告登录后偶尔会话丢失，帮我排查 src/session/ 下的会话管理逻辑
```

使用 `fix` 工作流：

```
帮我排查并修复会话丢失的问题，现象是登录后偶尔 401
```

Codex 调用 `mimo_compose(workflow: "fix", task: "...")`，MiMoCode 会按 debug → tdd → verify → feedback 流程执行。

---

### 场景三：CI 失败修复

CI 挂了？把日志喂给 MiMoCode：

```
CI 挂了，日志在 ci.log，帮我修复
```

Codex 调用 `mimo_fix_ci(file: "ci.log")` 或 `mimo_compose(workflow: "fix-ci", file: "ci.log")`。

也可以直接在 Codex 中操作：

```
把 CI 失败日志保存到 ci.log，然后用 MiMoCode 修复
```

---

### 场景四：长任务 — 后台执行

预计超过 5 分钟的任务，使用后台模式：

```
帮我重构 src/api/ 下所有控制器，统一错误处理方式，这个改动比较大，后台跑吧
```

Codex 调用 `mimo_compose(workflow: "dev", task: "...", background: true)`，立即返回 `jobId`。

查看进度：

```
MiMoCode 任务进度怎么样了
```

Codex 调用 `mimo_status(jobId: "...")`，返回当前阶段、耗时、最近日志。

获取结果：

```
MiMoCode 任务完成了吗，给我结果
```

Codex 调用 `mimo_result(jobId: "...")`，返回最终状态、变更文件、报告路径。

取消任务：

```
取消那个重构任务
```

Codex 调用 `mimo_cancel(jobId: "...")`。

---

### 场景五：继续未完成的工作

如果之前的 MiMoCode 任务超时或中断了，可以恢复：

```
上次的实现没跑完，帮我继续，session ID 是 ses_xxx
```

Codex 调用 `mimo_resume(session: "ses_xxx", task: "继续上次的任务")`。

也可以从 job 维度恢复：

```
继续之前的 job 2026-06-27T10-00-00-compose-dev，把剩余的测试补完
```

Codex 调用 `mimo_resume_job(jobId: "...", task: "补完剩余测试")`。

---

### 场景六：执行已有的实施计划

如果已经有一份写好的计划文档：

```
按照 doc/api-refactor-plan.md 里的计划执行重构
```

Codex 调用 `mimo_compose(workflow: "execute-plan", file: "doc/api-refactor-plan.md")`。

---

### 完整 Vibe Coding 流程总结

```
接到需求
  │
  ├─ 需求清晰？ ──否──→ mimo_compose(workflow: "brainstorm")
  │                          │
  │                          ↓
  │                     澄清需求
  │
  ├─ 需要计划？ ──是──→ mimo_plan / mimo_compose(workflow: "plan")
  │                          │
  │                          ↓
  │                     生成实施计划
  │
  ↓
实现
  │
  ├─ 完整功能 ──→ mimo_compose(workflow: "dev")
  ├─ 小改动   ──→ mimo_implement(allowWrite: true)
  ├─ Bug 修复 ──→ mimo_compose(workflow: "fix")
  ├─ CI 修复  ──→ mimo_fix_ci(file: "ci.log")
  │
  ↓
验证
  │
  ├─ 运行测试 ──→ npm test / 项目验证命令
  ├─ 代码审查 ──→ mimo_review / mimo_compose(workflow: "review")
  │
  ↓
完成
  │
  └─ Codex 汇总结果，报告给用户
```

### CLI 等效命令

以上所有操作也可以通过命令行直接执行：

```bash
# 需求分析
codex-mimo compose --workflow brainstorm "分析登录速率限制需求"

# 生成计划
codex-mimo plan "实现登录速率限制，每分钟 5 次，基于 IP"

# 完整开发
codex-mimo compose --workflow dev "实现登录速率限制功能"

# 直接实现
codex-mimo implement "在 src/middleware/ 添加速率限制中间件"

# 代码审查
codex-mimo review

# CI 修复
codex-mimo fix-ci --file ci.log

# 后台执行
codex-mimo compose --workflow dev --timeout-ms 600000 "重构 API 控制器"
```
