/**
 * 测试 HTTP Callback Hook
 * 
 * 模拟发送回调到接收服务器
 */

async function testCallback() {
  const endpoint = process.env.MIMO_CALLBACK_ENDPOINT || "http://localhost:3000/api/mimo-callback"
  
  console.log(`🧪 测试回调发送到: ${endpoint}\n`)

  // 测试数据
  const testPayloads = [
    {
      name: "会话完成",
      data: {
        event: "session.post",
        timestamp: new Date().toISOString(),
        sessionID: "ses_test_001",
        outcome: "completed",
        task: "实现一个计算器功能",
        result: "已完成计算器功能，支持加减乘除四则运算。包含单元测试，覆盖率达到 95%。",
        metadata: {
          agentID: "agent_build",
          trajectoryLength: 15,
        },
      },
    },
    {
      name: "Actor 停止",
      data: {
        event: "actor.postStop",
        timestamp: new Date().toISOString(),
        sessionID: "ses_test_002",
        agentType: "explore",
        outcome: "success",
        task: "探索项目结构",
        result: "项目包含 14 个核心模块，主要分为 CLI、MCP Server、Core 三层架构。",
        metadata: {
          actorID: "actor_explore_001",
          mode: "subagent",
          lifecycle: "ephemeral",
          iteration: 3,
        },
      },
    },
    {
      name: "任务失败",
      data: {
        event: "session.post",
        timestamp: new Date().toISOString(),
        sessionID: "ses_test_003",
        outcome: "error",
        task: "部署到生产环境",
        error: "部署失败: 权限不足，无法访问生产服务器",
        metadata: {
          agentID: "agent_build",
          trajectoryLength: 8,
        },
      },
    },
  ]

  for (const { name, data } of testPayloads) {
    console.log(`📤 发送测试: ${name}`)
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "MiMoCode-Callback-Test/1.0",
        },
        body: JSON.stringify(data),
      })

      if (response.ok) {
        const result = await response.json()
        console.log(`✅ 成功: ${JSON.stringify(result)}\n`)
      } else {
        console.log(`❌ 失败: ${response.status} ${response.statusText}\n`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`❌ 错误: ${message}\n`)
    }

    // 等待 1 秒
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  console.log("✨ 测试完成")
}

testCallback().catch(console.error)
