import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { ExecutionCallbackSummary } from "../core/jobs.js";
import {
  MAX_ALLOWED_PATHS_JSON_ENV_CHARS,
  MAX_STAGED_CALLBACKS,
  WRITE_PATH_FIELD_PRIORITY,
  WRITE_TOOL_NAMES,
  type HookExecutionGuardInput,
  type HookGuardFailure
} from "../core/safety-contracts.js";

export const CALLBACK_HEADER = "x-codex-mimo-callback-token";
export type MimoHookEventName = "session.post";
export type MimoHookOutcome = "completed" | "error" | "cancelled";

export interface MimoHookCallbackPayload {
  invocationId: string;
  event: MimoHookEventName;
  timestamp: string;
  sessionID: string;
  outcome: MimoHookOutcome;
  guardFailure?: HookGuardFailure;
}

export interface MimoHookCallbackSummary {
  invocationId: string;
  event: MimoHookEventName;
  receivedAt: string;
  sessionId: string;
  outcome: MimoHookOutcome;
  guardFailure?: HookGuardFailure;
}

export interface HookConfigPaths {
  configDir: string;
  pluginDir: string;
  hookFile: string;
}

export interface HookCallbackController {
  invocationId: string;
  token: string;
  endpoint: string;
  configDir: string;
  callbackFile: string;
  env: Record<string, string>;
  bindRunSession(sessionId: string): void;
  getRunSession(): string | undefined;
  getDiagnostics(): string[];
  waitForCallback: () => Promise<MimoHookCallbackSummary | null>;
  close: () => Promise<void>;
}

export interface HookCallbackControllerDeps {
  writeHookConfig?: typeof writeHookConfig;
}

export interface ExecutionCallbackEvidence {
  executionCallback: ExecutionCallbackSummary;
}

export type { HookExecutionGuardInput };

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
    outcome: payload.outcome,
    ...(payload.guardFailure ? { guardFailure: payload.guardFailure } : {})
  };
}

export function toExecutionCallbackEvidence(
  invocationId: string,
  callback: MimoHookCallbackSummary | null,
  diagnostics: string[] = []
): ExecutionCallbackEvidence {
  if (!callback) {
    const diagnosticSuffix = diagnostics.length > 0
      ? ` Diagnostics: ${diagnostics.join("; ")}`
      : "";
    return {
      executionCallback: {
        invocationId,
        outcome: "missing",
        error: `MiMoCode exited before codex-mimo received session.post.${diagnosticSuffix}`
      }
    };
  }
  return {
    executionCallback: {
      invocationId: callback.invocationId,
      outcome: callback.outcome,
      sessionId: callback.sessionId,
      receivedAt: callback.receivedAt,
      ...(callback.outcome === "error"
        ? { error: "MiMoCode completion callback reported an error." }
        : callback.outcome === "cancelled"
          ? { error: "MiMoCode completion callback reported cancellation." }
          : {})
    }
  };
}

export function writeHookConfig(input: {
  cwd: string;
  invocationId: string;
  endpoint: string;
  token: string;
}): HookConfigPaths {
  const configDir = path.join(input.cwd, ".codex-mimo", "runtime-hooks", input.invocationId);
  const pluginDir = path.join(configDir, "plugin");
  const hookFile = path.join(pluginDir, "codex-mimo-callback.js");

  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(hookFile, buildHookSource(), "utf-8");

  return { configDir, pluginDir, hookFile };
}

function buildHookSource(): string {
  return `import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";

const CALLBACK_HEADER = ${JSON.stringify(CALLBACK_HEADER)};
const WRITE_TOOL_NAMES = ${JSON.stringify([...WRITE_TOOL_NAMES])};
const WRITE_PATH_FIELD_PRIORITY = ${JSON.stringify([...WRITE_PATH_FIELD_PRIORITY])};
const PROMPT_MISMATCH_CANCEL_REASON = "Codex-MiMo blocked a query that did not match the expected task identity.";
const WRITE_SCOPE_CANCEL_REASON = "Codex-MiMo blocked an out-of-scope file write.";

function pick(input, ...keys) {
  for (const key of keys) {
    if (input && input[key] !== undefined) return input[key];
  }
  return undefined;
}

function timingSafeEqualHex(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function hashQuery(query) {
  return createHash("sha256").update(String(query ?? ""), "utf8").digest("hex");
}

function normalizeRepositoryPath(filePath) {
  return String(filePath).replace(/\\\\/g, "/");
}

function validateAllowedPathPattern(pattern) {
  const normalized = normalizeRepositoryPath(pattern.trim());
  if (!normalized || normalized === ".") return "empty or dot path";
  if (normalized === "**") return "bare double-star";
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return "absolute path";
  if (normalized.includes("..")) return "parent traversal";
  if (normalized.startsWith("//") || normalized.startsWith("\\\\")) return "UNC path";
  if (normalized.includes("?") || normalized.includes("[") || normalized.includes("]")) return "unsupported glob";
  if (normalized.includes("*")) {
    if (!normalized.endsWith("/**")) return "unsupported glob";
    const prefix = normalized.slice(0, -3);
    if (!prefix || prefix.includes("*")) return "unsupported glob";
  }
  return null;
}

function matchesAllowedPattern(filePath, pattern) {
  const normalizedPattern = normalizeRepositoryPath(pattern.trim());
  if (validateAllowedPathPattern(normalizedPattern) !== null) return false;
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(prefix + "/");
  }
  return filePath === normalizedPattern || filePath.startsWith(normalizedPattern + "/");
}

function isPathWithinAllowedScope(filePath, allowedPaths) {
  const normalized = normalizeRepositoryPath(filePath);
  return allowedPaths.some((pattern) => matchesAllowedPattern(normalized, pattern));
}

function readAllowedPaths() {
  const raw = process.env.CODEX_MIMO_ALLOWED_PATHS_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function resolveWritePath(input) {
  const state = input?.state ?? input;
  const toolInput = state?.input ?? input?.input ?? input;
  for (const field of WRITE_PATH_FIELD_PRIORITY) {
    const value = pick(toolInput, field);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function toRepositoryRelativePath(workspaceRoot, rawPath) {
  const normalizedWorkspace = path.resolve(workspaceRoot);
  const resolved = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(normalizedWorkspace, rawPath);
  const relative = path.relative(normalizedWorkspace, resolved);
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return normalizeRepositoryPath(relative);
}

function truncatePath(filePath) {
  const normalized = normalizeRepositoryPath(filePath);
  return normalized.length > 240 ? normalized.slice(0, 240) : normalized;
}

function resolveToolName(input) {
  return pick(input, "tool", "name", "toolName") ?? pick(input?.part, "tool", "name", "toolName");
}

export default async function codexMimoCallbackPlugin() {
  let primarySessionId;
  let firstPrimaryQueryChecked = false;
  let guardFailure;

  return {
    "session.pre": async (input = {}) => {
      const sessionID = pick(input, "sessionID", "sessionId");
      if (!sessionID || primarySessionId) return;
      primarySessionId = sessionID;
    },
    "session.userQuery.pre": async (input = {}, output = {}) => {
      const sessionID = pick(input, "sessionID", "sessionId");
      if (!sessionID || !primarySessionId || sessionID !== primarySessionId || firstPrimaryQueryChecked) {
        return;
      }
      firstPrimaryQueryChecked = true;
      const expectedHash = process.env.CODEX_MIMO_EXPECTED_QUERY_HASH;
      if (!expectedHash) return;
      const actualHash = hashQuery(input.query);
      if (timingSafeEqualHex(actualHash, expectedHash)) return;
      guardFailure = { code: "prompt_identity_mismatch", sessionId: sessionID };
      output.cancel = true;
      output.cancelReason = PROMPT_MISMATCH_CANCEL_REASON;
    },
    "tool.execute.before": async (input = {}, output = {}) => {
      const sessionID = pick(input, "sessionID", "sessionId") ?? primarySessionId;
      const toolName = resolveToolName(input);
      if (!toolName || !WRITE_TOOL_NAMES.includes(toolName)) return;
      const allowedPaths = readAllowedPaths();
      if (allowedPaths.length === 0) return;
      const rawPath = resolveWritePath(input);
      if (!rawPath) {
        guardFailure = {
          code: "write_scope_violation",
          sessionId: sessionID ?? "unknown",
          path: "unknown"
        };
        output.cancel = true;
        output.cancelReason = WRITE_SCOPE_CANCEL_REASON;
        return;
      }
      const relativePath = toRepositoryRelativePath(process.cwd(), rawPath);
      if (!relativePath || !isPathWithinAllowedScope(relativePath, allowedPaths)) {
        guardFailure = {
          code: "write_scope_violation",
          sessionId: sessionID ?? "unknown",
          path: truncatePath(relativePath ?? rawPath)
        };
        output.cancel = true;
        output.cancelReason = WRITE_SCOPE_CANCEL_REASON;
      }
    },
    "session.post": async (input = {}) => {
      const endpoint = process.env.CODEX_MIMO_CALLBACK_ENDPOINT;
      const token = process.env.CODEX_MIMO_CALLBACK_TOKEN;
      const invocationId = process.env.CODEX_MIMO_INVOCATION_ID;
      if (!endpoint || !token || !invocationId) return;

      const sessionID = pick(input, "sessionID", "sessionId");
      if (!sessionID || !primarySessionId || sessionID !== primarySessionId) return;

      const payload = {
        invocationId,
        event: "session.post",
        timestamp: new Date().toISOString(),
        sessionID,
        outcome: input.outcome,
        ...(guardFailure ? { guardFailure } : {})
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
}
`;
}

function serializeAllowedPathsForEnv(allowedPaths?: string[]): string | undefined {
  if (!allowedPaths || allowedPaths.length === 0) return undefined;
  const json = JSON.stringify(allowedPaths);
  if (json.length > MAX_ALLOWED_PATHS_JSON_ENV_CHARS) {
    throw new Error(
      `allowedPaths JSON exceeds ${MAX_ALLOWED_PATHS_JSON_ENV_CHARS} characters for hook environment transport.`
    );
  }
  return json;
}

export async function createHookCallbackController(
  input: {
    cwd: string;
    kind: string;
    callbackWaitMs?: number;
    now?: () => number;
    random?: () => string;
  } & HookExecutionGuardInput,
  deps: HookCallbackControllerDeps = {}
): Promise<HookCallbackController> {
  const invocationId = createInvocationId(input.kind, input.now, input.random);
  const token = crypto.randomBytes(16).toString("hex");
  const callbackWaitMs = input.callbackWaitMs ?? 10_000;
  const callbackDir = path.join(input.cwd, ".codex-mimo", "callbacks");
  const callbackFile = path.join(callbackDir, `${invocationId}.json`);
  const allowedPathsJson = serializeAllowedPathsForEnv(input.allowedPaths);

  fs.mkdirSync(callbackDir, { recursive: true });

  let settled = false;
  let timer: NodeJS.Timeout | null = null;
  let boundRunSession: string | undefined;
  const stagedCallbacks: MimoHookCallbackSummary[] = [];
  const diagnostics: string[] = [];
  let resolveCallback!: (value: MimoHookCallbackSummary | null) => void;
  const callbackPromise = new Promise<MimoHookCallbackSummary | null>((resolve) => {
    resolveCallback = resolve;
  });

  const recordDiagnostic = (message: string) => {
    diagnostics.push(message);
  };

  const acceptCallback = (summary: MimoHookCallbackSummary) => {
    if (settled) return;
    settled = true;
    clearCallbackTimer();
    fs.writeFileSync(callbackFile, JSON.stringify(summary, null, 2), "utf-8");
    resolveCallback(summary);
  };

  const tryAcceptCallback = (summary: MimoHookCallbackSummary) => {
    if (settled) return;
    if (boundRunSession !== undefined && summary.sessionId !== boundRunSession) {
      recordDiagnostic(
        `Ignored session.post from ${summary.sessionId}; bound run session is ${boundRunSession}.`
      );
      return;
    }
    acceptCallback(summary);
  };

  const stageCallback = (summary: MimoHookCallbackSummary) => {
    if (stagedCallbacks.length >= MAX_STAGED_CALLBACKS) {
      recordDiagnostic(`Dropped session.post from ${summary.sessionId}; staged callback limit reached.`);
      return;
    }
    stagedCallbacks.push(summary);
  };

  const flushStagedCallbacks = () => {
    if (settled || boundRunSession === undefined) return;
    const match = stagedCallbacks.find((entry) => entry.sessionId === boundRunSession);
    if (match) tryAcceptCallback(match);
  };

  const flushFirstStagedCallback = () => {
    if (settled || boundRunSession !== undefined || stagedCallbacks.length === 0) return;
    tryAcceptCallback(stagedCallbacks[0]!);
  };

  const bindRunSession = (sessionId: string) => {
    boundRunSession = sessionId;
    flushStagedCallbacks();
  };

  const getRunSession = () => boundRunSession;

  const startTimer = () => {
    if (settled || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!settled) {
        if (boundRunSession === undefined && stagedCallbacks.length > 0) {
          recordDiagnostic("Timed out before run session binding with staged callbacks present.");
        } else if (boundRunSession !== undefined) {
          recordDiagnostic(`Timed out waiting for session.post from bound run session ${boundRunSession}.`);
        } else {
          recordDiagnostic("Timed out waiting for session.post.");
        }
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

        const summary = buildCallbackSummary(payload);
        if (boundRunSession === undefined) {
          stageCallback(summary);
        } else {
          tryAcceptCallback(summary);
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
    bindRunSession,
    getRunSession,
    getDiagnostics: () => [...diagnostics],
    env: {
      CODEX_MIMO_INVOCATION_ID: invocationId,
      CODEX_MIMO_CALLBACK_ENDPOINT: endpoint,
      CODEX_MIMO_CALLBACK_TOKEN: token,
      CODEX_MIMO_EXPECTED_QUERY_HASH: input.expectedQueryHash,
      ...(allowedPathsJson ? { CODEX_MIMO_ALLOWED_PATHS_JSON: allowedPathsJson } : {}),
      MIMOCODE_CONFIG_DIR: hookConfig.configDir
    },
    waitForCallback: () => {
      flushFirstStagedCallback();
      flushStagedCallbacks();
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
    server.closeAllConnections();
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
