/**
 * 示例：HTTP 回调接收服务器
 * 
 * 用于接收 MiMoCode 的任务完成回调
 * 
 * 启动方式：
 * npx tsx hooks/callback-receiver.ts
 */

import http from "node:http"

interface CallbackPayload {
  event: string
  timestamp: string
  sessionID: string
  agentType?: string
  outcome?: string
  task?: string
  result?: string
  error?: string
  metadata?: Record<string, unknown>
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/mimo-callback") {
    let body = ""

    req.on("data", (chunk) => {
      body += chunk.toString()
    })

    req.on("end", () => {
      try {
        const payload: CallbackPayload = JSON.parse(body)
        
        console.log("\n" + "=".repeat(60))
        console.log(`📩 收到 MiMoCode 回调`)
        console.log("=".repeat(60))
        console.log(`事件类型: ${payload.event}`)
        console.log(`时间: ${payload.timestamp}`)
        console.log(`会话 ID: ${payload.sessionID}`)
        
        if (payload.agentType) {
          console.log(`Agent 类型: ${payload.agentType}`)
        }
        
        if (payload.outcome) {
          console.log(`执行结果: ${payload.outcome}`)
        }
        
        if (payload.task) {
          console.log(`任务描述: ${payload.task}`)
        }
        
        if (payload.result) {
          console.log(`返回内容:\n${payload.result.substring(0, 500)}${payload.result.length > 500 ? "..." : ""}`)
        }
        
        if (payload.error) {
          console.log(`错误信息: ${payload.error}`)
        }
        
        if (payload.metadata) {
          console.log(`元数据: ${JSON.stringify(payload.metadata, null, 2)}`)
        }
        
        console.log("=".repeat(60) + "\n")

        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: true, received: true }))
      } catch (error) {
        console.error("解析回调数据失败:", error)
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: false, error: "Invalid JSON" }))
      }
    })
  } else {
    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "Not Found" }))
  }
})

const PORT = 3000

server.listen(PORT, () => {
  console.log(`🚀 MiMoCode 回调接收服务器已启动`)
  console.log(`📡 监听地址: http://localhost:${PORT}/api/mimo-callback`)
  console.log(`\n使用方式:`)
  console.log(`1. 启动此服务器`)
  console.log(`2. 设置环境变量:`)
  console.log(`   MIMO_CALLBACK_ENDPOINT=http://localhost:${PORT}/api/mimo-callback`)
  console.log(`3. 运行 MiMoCode 任务`)
  console.log(`4. 任务完成后，回调会自动发送到此服务器\n`)
})
