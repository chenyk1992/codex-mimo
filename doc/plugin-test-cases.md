# Codex MiMoCode 插件测试用例

## 测试方式
在 Codex App 中直接输入以下自然语言指令，观察 Codex 是否正确调用 MiMoCode 工具并返回结果。

---

## 测试 1: 基础健康检查

**输入：**
```
帮我检查一下 MiMoCode 是否可用
```

**预期行为：** Codex 调用 mimo_healthcheck，返回版本号和状态

---

## 测试 2: 简单计划任务

**输入：**
```
帮我规划一下如何给这个项目添加一个 .gitignore 文件
```

**预期行为：** Codex 调用 mimo_plan，返回实现计划

---

## 测试 3: 代码审查

**输入：**
```
帮我看看当前有哪些代码改动，有没有问题
```

**预期行为：** Codex 调用 mimo_review，返回审查结果

---

## 测试 4: Compose 开发工作流

**输入：**
```
用 compose dev 工作流帮我创建一个简单的 CHANGELOG.md 文件
```

**预期行为：** Codex 调用 mimo_compose，执行完整开发流程并生成报告

---

## 测试 5: Compose 计划工作流

**输入：**
```
用 compose plan 工作流分析一下这个项目应该怎么添加单元测试
```

**预期行为：** Codex 调用 mimo_compose，只读分析不修改文件

---

## 测试 6: 实际实现任务

**输入：**
```
帮我在这个项目里创建一个 src/utils/helpers.ts 文件，导出一个 add 函数
```

**预期行为：** Codex 调用 mimo_implement，实际创建文件

---

## 测试 7: 查看报告

**输入：**
```
帮我看看 .codex-mimo/reports 目录下有什么报告文件
```

**预期行为：** Codex 列出生成的报告文件

---

## 测试记录

| 测试 | 输入摘要 | 结果 | 备注 |
|------|----------|------|------|
| 1 | 检查 MiMoCode | ⬜ | |
| 2 | 规划 .gitignore | ⬜ | |
| 3 | 审查代码改动 | ⬜ | |
| 4 | compose dev | ⬜ | |
| 5 | compose plan | ⬜ | |
| 6 | 创建 helpers.ts | ⬜ | |
| 7 | 查看报告 | ⬜ | |
