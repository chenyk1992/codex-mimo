# Codex-MiMo Vibe Coding End-to-End Manual

本文档用于完整演练 `codex-mimo` 从需求分析、计划、代码实现、测试、修复到审查的闭环。演练使用隔离的新项目，不把 demo 代码混入 `codex-mimo` 主项目。

## 目标

验证 `codex-mimo` 在真实小项目中的端到端使用路径：

1. 健康检查：确认 MiMoCode CLI 可用。
2. 需求分析：用 `compose --workflow brainstorm` 梳理需求。
3. 实施计划：用 `compose --workflow plan` 生成计划。
4. 代码实现：用 `compose --workflow dev` 让 MiMoCode 修改 demo 项目。
5. 测试验证：运行 demo 项目的 `npm.cmd test`。
6. 审查反馈：用 `compose --workflow review` 检查 diff。
7. 修复迭代：用 `compose --workflow fix` 处理 review 反馈。
8. 问题反馈：如果发现 `codex-mimo` 自身问题，把复现信息发送到修复专线会话 `019f0d74-0663-7ac1-b898-1c0188ee1f9d`，等待该会话修复后再重试。

## 演练项目

最终 clean run 使用的 demo 项目路径：

```text
E:\ideaProjects\codex-mimo\.codex-mimo\e2e-vibe-demo-clean
```

该目录位于 `.codex-mimo/` 下，是运行期沙箱，不作为主项目提交内容。第一次演练目录 `e2e-vibe-demo` 保留为问题现场；最终记录以 `e2e-vibe-demo-clean` 为准。

Demo 项目是一个 Node.js ESM 小项目：

- `src/pricing.js`：订单计价器。
- `test/pricing.test.js`：基于 Node 内置 test runner 的测试。
- `package.json`：只依赖 Node 内置能力，无需 `npm install`。

## 演练需求

对 demo 项目新增折扣码能力：

```text
给订单计价器增加折扣码支持。

当前 calculateOrderTotal(items, options) 已能计算 subtotal、tax、total。
请新增可选参数 discountCode，支持：
- SAVE10：对税前小计打 10% 折扣。
- FREESHIP：不改变金额，但在返回结果中标记 freeShipping: true。
- 未知折扣码：抛出带有 Unknown discount code 的错误。

要求：
- 保持现有 API 兼容。
- 金额保留两位小数。
- 增加或更新测试。
- npm.cmd test 必须通过。
```

## 推荐命令

以下命令均在主仓库中执行，通过当前构建产物调用 `codex-mimo`：

```powershell
$bridge = "E:\ideaProjects\codex-mimo\dist\cli\main.js"
$demo = "E:\ideaProjects\codex-mimo\.codex-mimo\e2e-vibe-demo-clean"

node $bridge healthcheck --cwd $demo

node $bridge compose --cwd $demo --workflow brainstorm --timeout-ms 180000 "给订单计价器增加折扣码支持，先分析需求和实现边界"

node $bridge compose --cwd $demo --workflow plan --timeout-ms 240000 "给订单计价器增加折扣码支持：SAVE10 税前九折；FREESHIP 标记 freeShipping；未知码抛错；保持 API 兼容；补测试；npm.cmd test 通过"

node $bridge compose --cwd $demo --workflow dev --timeout-ms 600000 --verify "npm.cmd test" "实现折扣码支持：SAVE10 税前九折；FREESHIP 标记 freeShipping；未知码抛出 Unknown discount code；金额两位小数；保持 API 兼容；补充 Node test 测试"

npm.cmd test --prefix $demo

node $bridge compose --cwd $demo --workflow review --since HEAD --timeout-ms 240000

node $bridge compose --cwd $demo --workflow fix --timeout-ms 300000 --verify "npm.cmd test" "根据 review 反馈做最小修复：把 src/pricing.js 中表示百分比的局部变量 discount 重命名为 discountPercent，避免和返回的折扣金额字段混淆；把返回对象字段顺序调整为 subtotal, discount, tax, total, freeShipping；不要扩大功能范围；保持 npm.cmd test 通过"

node $bridge compose --cwd $demo --workflow review --since HEAD --timeout-ms 240000
```

## 问题反馈协议

如果任一步骤暴露 `codex-mimo` 自身问题，而不是 demo 项目需求实现问题，把以下信息发送到修复专线会话：

```text
目标会话：019f0d74-0663-7ac1-b898-1c0188ee1f9d
来源会话：当前端到端演练会话
目标：codex-mimo vibe coding 全流程演练
问题步骤：<healthcheck|brainstorm|plan|dev|test|review|fix>
执行目录：<demo path>
命令：<exact command>
退出码：<exit code>
关键输出：<stderr/stdout summary>
相关报告：<.codex-mimo/reports/*.md 或 job/report path>
判断：为什么这像 codex-mimo 问题，而不是 demo 业务问题
期望：请定位并修复 codex-mimo，然后回复可重试步骤
```

发送后，当前会话应等待 `019f0d74-0663-7ac1-b898-1c0188ee1f9d` 的回复，再继续重试。

## 本次发现并反馈的问题

本次完整演练中，向修复专线会话反馈并完成修复的问题如下：

| 问题 | 触发步骤 | 现象 | 修复结果 |
| --- | --- | --- | --- |
| Git dubious ownership / `safe.directory` | `brainstorm` 后置检查 | 子项目 git 调用失败，导致只读 workflow 后处理异常 | `src/git/diff.ts` 内部 git 调用加入命令级 `safe.directory`，并补充 `git-diff` 测试 |
| 只读 workflow 未正确处理 HEAD 移动 | `plan` | `plan` 运行期间产生提交，报告没有清晰暴露 HEAD 变化 | Compose 报告加入 HEAD before/after 与 commit range；`plan` prompt 强化为只输出计划、不写文件不提交 |
| 语义失败检测误报 | `dev` | MiMoCode 正常实现且测试通过，但 `no ambiguity. Creating tasks` 被误判为没有接收任务 | 收窄 `detectSemanticFailure()` 正则，补充语义失败单测；`dev` 重试通过 |

## 本次实际执行记录

| Step | Command | Result | Notes |
| --- | --- | --- | --- |
| healthcheck | `node dist\cli\main.js healthcheck --cwd ...\e2e-vibe-demo-clean` | passed | 输出 `{"ok":true,"version":"0.1.3"}` |
| baseline test | `npm.cmd test` | passed | 初始 demo 3 个测试通过 |
| brainstorm | `compose --workflow brainstorm` | passed | 报告：`...\reports\2026-06-28T09-40-51-792Z-compose-brainstorm.md`；未改文件 |
| plan | `compose --workflow plan` | passed | 报告：`...\reports\2026-06-28T09-41-44-428Z-compose-plan.md`；未改文件，HEAD before/after 均为 `2ff3a62` |
| dev first run | `compose --workflow dev --verify "npm.cmd test"` | failed by codex-mimo false positive | 实现和测试实际通过，但语义失败检测误报；已反馈并修复 |
| dev retry | `compose --workflow dev --verify "npm.cmd test"` | passed | 报告：`...\reports\2026-06-28T09-54-44-525Z-compose-dev.md`；修改 `src/pricing.js` 和 `test/pricing.test.js` |
| test | `npm.cmd test` | passed | 折扣码实现后 7 个测试通过 |
| review | `compose --workflow review --since HEAD` | passed with fixes requested | 报告：`...\reports\2026-06-28T09-55-54-605Z-compose-review.md`；建议变量命名和返回字段顺序修正 |
| fix | `compose --workflow fix --verify "npm.cmd test"` | passed | 报告：`...\reports\2026-06-28T09-58-12-696Z-compose-fix.md`；按 review 做最小修复 |
| final test | `npm.cmd test` | passed | 最终 demo 7 个测试通过 |
| final review | `compose --workflow review --since HEAD` | passed | 报告：`...\reports\2026-06-28T09-59-34-711Z-compose-review.md`；结论为 ready to merge |

## 完成标准

本手册中的全流程完成标准：

- `healthcheck` 成功。
- `brainstorm` 和 `plan` 均不修改 demo 文件。
- `dev` 完成需求实现，并通过 `npm.cmd test`。
- `review` 能基于当前 diff 给出审查结论。
- `fix` 能按 review 反馈做最小修复，并再次通过测试。
- 如果发现 `codex-mimo` 自身问题，必须记录命令、输出、报告路径，并发往修复专线会话等待修复。

## 收尾建议

演练结束后，demo 项目一般会保留未提交 diff，便于人工查看 MiMoCode 的实际改动。需要长期保存时，可在 demo 项目中单独提交；不需要时，可以删除 `.codex-mimo/e2e-vibe-demo-clean` 重新跑一遍 clean run。
