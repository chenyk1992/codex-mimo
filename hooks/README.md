# MiMoCode HTTP Callback Hook

当 MiMoCode 任务完成时，主动推送结果到指定的 HTTP 端点。

## 功能特性

- ✅ 支持多种事件类型（session.post, actor.postStop, tool.execute.after）
- ✅ 自动重试机制（指数退避）
- ✅ 可配置超时时间
- ✅ 支持自定义 HTTP Headers
- ✅ 环境变量配置

## 快速开始

### 1. 启动回调接收服务器

```bash
npx tsx hooks/callback-receiver.ts
```

服务器将在 `http://localhost:3000/api/mimo-callback` 监听。

### 2. 配置环境变量

```bash
# Windows PowerShell
$env:MIMO_CALLBACK_ENDPOINT="http://localhost:3000/api/mimo-callback"
$env:MIMO_CALLBACK_EVENTS='["session.post"]'

# Linux/macOS
export MIMO_CALLBACK_ENDPOINT="http://localhost:3000/api/mimo-callback"
export MIMO_CALLBACK_EVENTS='["session.post"]'
```

### 3. 运行 MiMoCode 任务

```bash
mimo run "你的任务描述"
```

### 4. 查看回调结果

回调接收服务器会实时显示收到的回调信息。

## 配置选项

### 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `MIMO_CALLBACK_ENDPOINT` | 回调端点 URL | 无（必须配置） |
| `MIMO_CALLBACK_HEADERS` | 自定义 HTTP Headers（JSON 格式） | `{}` |
| `MIMO_CALLBACK_EVENTS` | 监听的事件类型（JSON 数组） | `["session.post"]` |
| `MIMO_CALLBACK_TIMEOUT` | 超时时间（毫秒） | `5000` |
| `MIMO_CALLBACK_RETRY_COUNT` | 重试次数 | `3` |

### 支持的事件类型

| 事件 | 说明 |
|------|------|
| `session.post` | 会话完成时触发 |
| `actor.postStop` | Actor 停止时触发 |
| `tool.execute.after` | 工具执行完成后触发 |

## 回调数据格式

```json
{
  "event": "session.post",
  "timestamp": "2026-06-26T12:00:00.000Z",
  "sessionID": "ses_xxx",
  "outcome": "completed",
  "task": "任务描述",
  "result": "任务结果",
  "error": null,
  "metadata": {
    "agentID": "agent_xxx",
    "trajectoryLength": 10
  }
}
```

## 集成到现有项目

### 方式 1：作为 MiMoCode 插件

将 `http-callback.ts` 复制到项目的 `hooks/` 目录：

```bash
cp hooks/http-callback.ts ~/.mimocode/hooks/
```

### 方式 2：作为独立服务

1. 启动回调接收服务器
2. 配置环境变量
3. 运行 MiMoCode 任务

## 示例：接收回调并处理

```typescript
import http from "node:http"

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/mimo-callback") {
    let body = ""
    req.on("data", (chunk) => { body += chunk.toString() })
    req.on("end", () => {
      const payload = JSON.parse(body)
      
      // 处理回调
      console.log(`任务完成: ${payload.sessionID}`)
      console.log(`结果: ${payload.result}`)
      
      // 发送到其他系统
      // await sendToSlack(payload)
      // await updateDatabase(payload)
      // await notifyUser(payload)
      
      res.writeHead(200)
      res.end(JSON.stringify({ success: true }))
    })
  }
})

server.listen(3000)
```

## 故障排除

### 回调未发送

1. 检查环境变量是否正确设置
2. 检查回调服务器是否正在运行
3. 检查网络连接

### 回调发送失败

1. 检查端点 URL 是否正确
2. 检查防火墙设置
3. 增加超时时间或重试次数

## 相关链接

- [MiMoCode GitHub](https://github.com/XiaomiMiMo/MiMo-Code)
- [MiMoCode 插件文档](https://github.com/XiaomiMiMo/MiMo-Code/tree/main/packages/plugin)
