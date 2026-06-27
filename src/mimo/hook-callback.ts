import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const CALLBACK_HEADER = "x-codex-mimo-callback-token";
export type MimoHookEventName = "session.post";
export type MimoHookOutcome = "completed" | "error" | "cancelled";

export interface MimoHookCallbackPayload {
  invocationId: string;
  event: MimoHookEventName;
  timestamp: string;
  sessionID?: string;
  agentID?: string;
  task_id?: string;
  outcome?: MimoHookOutcome;
  error?: string;
  finalText?: string;
  assistantMessageID?: string;
  metadata?: {
    trajectoryLength?: number;
    [key: string]: unknown;
  };
}

export interface MimoHookCallbackSummary {
  invocationId: string;
  event: MimoHookEventName;
  receivedAt: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  outcome?: MimoHookOutcome;
  error?: string;
  finalText?: string;
  assistantMessageId?: string;
  trajectoryLength?: number;
}

export interface HookConfigPaths {
  configDir: string;
  hookDir: string;
  hooksDir: string;
  hookFile: string;
}

export interface HookCallbackController {
  invocationId: string;
  token: string;
  endpoint: string;
  configDir: string;
  callbackFile: string;
  env: Record<string, string>;
  waitForCallback: () => Promise<MimoHookCallbackSummary | null>;
  close: () => Promise<void>;
}

export interface HookCallbackControllerDeps {
  writeHookConfig?: typeof writeHookConfig;
}

export function createInvocationId(
  prefix: string,
  now: () => number = Date.now,
  random: () => string = () => crypto.randomBytes(4).toString("hex")
): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "mimo";
  return `${safePrefix}-${now().toString(36)}-${random()}`;
}

export function buildCallbackSummary(payload: MimoHookCallbackPayload): MimoHookCallbackSummary {
  return {
    invocationId: payload.invocationId,
    event: payload.event,
    receivedAt: payload.timestamp,
    sessionId: payload.sessionID,
    agentId: payload.agentID,
    taskId: payload.task_id,
    outcome: payload.outcome,
    error: payload.error,
    finalText: payload.finalText,
    assistantMessageId: payload.assistantMessageID,
    trajectoryLength: payload.metadata?.trajectoryLength
  };
}

export function writeHookConfig(input: {
  cwd: string;
  invocationId: string;
  endpoint: string;
  token: string;
}): HookConfigPaths {
  const configDir = path.join(input.cwd, ".codex-mimo", "runtime-hooks", input.invocationId);
  const hooksDir = path.join(configDir, "hooks");
  const hookFile = path.join(hooksDir, "codex-mimo-callback.js");

  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(hookFile, buildHookSource(), "utf-8");

  return { configDir, hookDir: hooksDir, hooksDir, hookFile };
}

function buildHookSource(): string {
  return `const CALLBACK_HEADER = ${JSON.stringify(CALLBACK_HEADER)};

function pick(input, ...keys) {
  for (const key of keys) {
    if (input && input[key] !== undefined) return input[key];
  }
  return undefined;
}

export default {
  "session.post": async (input = {}) => {
    const endpoint = process.env.CODEX_MIMO_CALLBACK_ENDPOINT;
    const token = process.env.CODEX_MIMO_CALLBACK_TOKEN;
    const invocationId = process.env.CODEX_MIMO_INVOCATION_ID;
    if (!endpoint || !token || !invocationId) return;

    const payload = {
      invocationId,
      event: "session.post",
      timestamp: new Date().toISOString(),
      sessionID: pick(input, "sessionID", "sessionId"),
      agentID: pick(input, "agentID", "agentId"),
      task_id: pick(input, "task_id", "taskId"),
      outcome: input.outcome,
      error: input.error,
      finalText: input.finalText,
      assistantMessageID: pick(input, "assistantMessageID", "assistantMessageId"),
      metadata: {
        trajectoryLength: Array.isArray(input.trajectory) ? input.trajectory.length : input.metadata?.trajectoryLength
      }
    };

    await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CALLBACK_HEADER]: token
      },
      body: JSON.stringify(payload)
    });
  }
};
`;
}

export async function createHookCallbackController(input: {
  cwd: string;
  kind: string;
  callbackWaitMs?: number;
  now?: () => number;
  random?: () => string;
}, deps: HookCallbackControllerDeps = {}): Promise<HookCallbackController> {
  const invocationId = createInvocationId(input.kind, input.now, input.random);
  const token = crypto.randomBytes(16).toString("hex");
  const callbackWaitMs = input.callbackWaitMs ?? 10_000;
  const callbackDir = path.join(input.cwd, ".codex-mimo", "callbacks");
  const callbackFile = path.join(callbackDir, `${invocationId}.json`);

  fs.mkdirSync(callbackDir, { recursive: true });

  let settled = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveCallback!: (value: MimoHookCallbackSummary | null) => void;
  const callbackPromise = new Promise<MimoHookCallbackSummary | null>((resolve) => {
    resolveCallback = resolve;
  });

  const startTimer = () => {
    if (settled || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!settled) {
        settled = true;
        resolveCallback(null);
      }
    }, callbackWaitMs);
  };

  const clearCallbackTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const resolveWithNull = () => {
    if (!settled) {
      settled = true;
      clearCallbackTimer();
      resolveCallback(null);
    }
  };

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/mimo-hook") {
      res.writeHead(404).end();
      return;
    }

    if (req.headers[CALLBACK_HEADER] !== token) {
      res.writeHead(401).end();
      return;
    }

    let body = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as MimoHookCallbackPayload;
        if (payload.invocationId !== invocationId || payload.event !== "session.post") {
          res.writeHead(409).end();
          return;
        }

        if (!isValidCallbackPayload(payload)) {
          res.writeHead(400).end();
          return;
        }

        if (!settled) {
          const summary = buildCallbackSummary(payload);
          fs.writeFileSync(callbackFile, JSON.stringify(payload, null, 2), "utf-8");
          settled = true;
          clearCallbackTimer();
          resolveCallback(summary);
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400).end();
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind hook callback server.");
  }

  const endpoint = `http://127.0.0.1:${address.port}/mimo-hook`;
  let hookConfig: HookConfigPaths;
  try {
    hookConfig = (deps.writeHookConfig ?? writeHookConfig)({ cwd: input.cwd, invocationId, endpoint, token });
  } catch (error) {
    resolveWithNull();
    await closeServer(server);
    throw error;
  }

  return {
    invocationId,
    token,
    endpoint,
    configDir: hookConfig.configDir,
    callbackFile,
    env: {
      CODEX_MIMO_INVOCATION_ID: invocationId,
      CODEX_MIMO_CALLBACK_ENDPOINT: endpoint,
      CODEX_MIMO_CALLBACK_TOKEN: token,
      MIMOCODE_CONFIG_DIR: hookConfig.configDir
    },
    waitForCallback: () => {
      startTimer();
      return callbackPromise;
    },
    close: async () => {
      resolveWithNull();
      await closeServer(server);
    }
  };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function isValidCallbackPayload(payload: MimoHookCallbackPayload): boolean {
  return (
    typeof payload.timestamp === "string" &&
    payload.timestamp.length > 0 &&
    typeof payload.sessionID === "string" &&
    payload.sessionID.length > 0 &&
    (payload.outcome === "completed" || payload.outcome === "error" || payload.outcome === "cancelled")
  );
}
