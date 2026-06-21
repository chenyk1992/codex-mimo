# ACP 消息流

## 概述

ACP（代理通信协议）是客户端与代理之间通过 stdio 传输的 JSON-RPC 协议。

## 生命周期

```
客户端                          代理 (MiMoCode)
  |                                |
  |--- initialize ---------------->|
  |<-- protocolVersion + caps -----|
  |                                |
  |--- session/new --------------->|
  |<-- sessionId ------------------|
  |                                |
  |--- session/prompt ------------>|
  |<-- session/update chunks ------|
  |<-- tool calls -----------------|
  |--- fs/read_text_file response->|
  |--- fs/write_text_file response>|
  |--- terminal/create response --->|
  |<-- session/prompt stop --------|
  |                                |
```

## 核心方法

### initialize

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": { "readTextFile": true, "writeTextFile": true },
      "terminal": true
    },
    "clientInfo": {
      "name": "codex-mimo",
      "title": "Codex MiMoCode Bridge",
      "version": "0.1.0"
    }
  }
}
```

### session/new

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "E:/ideaProjects/example-app",
    "mcpServers": []
  }
}
```

### session/prompt

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_abc123",
    "prompt": [{ "type": "text", "text": "修复失败的测试。" }]
  }
}
```

## 客户端处理器

| ACP 方法 | 桥接行为 |
|------------|-----------------|
| `session/request_permission` | 评估策略，自动允许安全操作 |
| `fs/read_text_file` | 规范化路径，验证，返回内容 |
| `fs/write_text_file` | 规范化路径，验证写入权限，执行写入 |
| `terminal/create` | 规范化工作目录，验证命令，启动进程 |
| `terminal/output` | 返回 stdout/stderr 和退出状态 |
| `terminal/wait_for_exit` | 等待完成（带超时） |
| `terminal/kill` | 停止进程 |
| `terminal/release` | 如果正在运行则停止，释放资源 |

## 事件类型

```typescript
type CodexMimoEvent =
  | { type: "message"; role: "agent" | "user"; text: string }
  | { type: "plan"; entries: Array<{ content: string; status: string }> }
  | { type: "tool"; id: string; title: string; kind: string; status: string }
  | { type: "diff"; path: string; oldText?: string; newText: string }
  | { type: "terminal"; id: string; output: string; exitCode?: number }
  | { type: "usage"; used: number; size: number };
```
