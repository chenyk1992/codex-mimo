/**
 * MiMoCode HTTP Callback Hook Plugin
 * 
 * 当任务完成时，主动推送结果到指定的 HTTP 端点。
 * 
 * 安装方式：
 * 1. 将此文件放入项目的 hooks/ 目录
 * 2. 在 codex-mimo.config.json 中配置回调端点
 * 
 * 配置示例：
 * {
 *   "httpCallback": {
 *     "endpoint": "http://localhost:3000/api/mimo-callback",
 *     "headers": { "Authorization": "Bearer xxx" },
 *     "events": ["session.post", "actor.postStop"]
 *   }
 * }
 */

import type { Hooks } from "@mimo-ai/plugin"

interface CallbackConfig {
  endpoint: string
  headers?: Record<string, string>
  events?: string[]
  timeout?: number
  retryCount?: number
}

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

async function sendCallback(
  config: CallbackConfig,
  payload: CallbackPayload
): Promise<void> {
  const { endpoint, headers = {}, timeout = 5000, retryCount = 3 } = config

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "MiMoCode-Callback/1.0",
          ...headers,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (response.ok) {
        console.log(`[http-callback] Sent ${payload.event} to ${endpoint} (attempt ${attempt})`)
        return
      }

      console.warn(
        `[http-callback] Failed to send ${payload.event}: ${response.status} ${response.statusText}`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(
        `[http-callback] Attempt ${attempt}/${retryCount} failed for ${payload.event}: ${message}`
      )
    }

    // 指数退避
    if (attempt < retryCount) {
      await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000))
    }
  }

  console.error(`[http-callback] All ${retryCount} attempts failed for ${payload.event}`)
}

function loadCallbackConfig(): CallbackConfig | null {
  try {
    // 从环境变量读取配置
    const endpoint = process.env.MIMO_CALLBACK_ENDPOINT
    if (!endpoint) return null

    return {
      endpoint,
      headers: process.env.MIMO_CALLBACK_HEADERS
        ? JSON.parse(process.env.MIMO_CALLBACK_HEADERS)
        : {},
      events: process.env.MIMO_CALLBACK_EVENTS
        ? JSON.parse(process.env.MIMO_CALLBACK_EVENTS)
        : ["session.post"],
      timeout: process.env.MIMO_CALLBACK_TIMEOUT
        ? parseInt(process.env.MIMO_CALLBACK_TIMEOUT)
        : 5000,
      retryCount: process.env.MIMO_CALLBACK_RETRY_COUNT
        ? parseInt(process.env.MIMO_CALLBACK_RETRY_COUNT)
        : 3,
    }
  } catch {
    return null
  }
}

export default async function HttpCallbackHook(): Promise<Hooks> {
  const config = loadCallbackConfig()

  if (!config) {
    console.log("[http-callback] No callback endpoint configured, hook disabled")
    return {}
  }

  console.log(`[http-callback] Hook enabled, endpoint: ${config.endpoint}`)

  const hooks: Hooks = {}

  // 会话完成回调
  if (config.events?.includes("session.post")) {
    hooks["session.post"] = async (input, output) => {
      const payload: CallbackPayload = {
        event: "session.post",
        timestamp: new Date().toISOString(),
        sessionID: input.sessionID,
        outcome: input.outcome,
        task: input.task,
        result: input.finalText,
        error: input.error,
        metadata: {
          agentID: input.agentID,
          outcome: input.outcome,
          trajectoryLength: input.trajectory?.length ?? 0,
        },
      }

      await sendCallback(config, payload)
    }
  }

  // Actor 停止回调
  if (config.events?.includes("actor.postStop")) {
    hooks["actor.postStop"] = async (input, output) => {
      const payload: CallbackPayload = {
        event: "actor.postStop",
        timestamp: new Date().toISOString(),
        sessionID: input.sessionID,
        agentType: input.agentType,
        outcome: input.outcome,
        task: input.task,
        result: input.finalText,
        error: input.error,
        metadata: {
          actorID: input.actorID,
          mode: input.mode,
          lifecycle: input.lifecycle,
          iteration: input.iteration,
        },
      }

      await sendCallback(config, payload)
    }
  }

  // 工具执行后回调（可选）
  if (config.events?.includes("tool.execute.after")) {
    hooks["tool.execute.after"] = async (input, output) => {
      const payload: CallbackPayload = {
        event: "tool.execute.after",
        timestamp: new Date().toISOString(),
        sessionID: input.sessionID,
        metadata: {
          tool: input.tool,
          callID: input.callID,
          outputLength: output.output?.length ?? 0,
        },
      }

      await sendCallback(config, payload)
    }
  }

  return hooks
}
