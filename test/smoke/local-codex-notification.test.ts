import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { readJob } from "../../src/core/job-store.js";
import { probeCodexCommand } from "../../src/notify/codex-command.js";
import { readNotificationDeliveries } from "../../src/notify/dispatcher.js";
import type { NotificationDelivery } from "../../src/notify/types.js";
import {
  prepareCodexNotificationSmokeEnvironment,
  resolveInstalledPluginRoot,
} from "./local-codex-notification-support.js";

const enabled = process.platform === "win32" && process.env.RUN_LOCAL_CODEX_NOTIFY_SMOKE === "1";
const describeSmoke = enabled ? describe : describe.skip;
const checkoutRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUTPUT_MARKER = "CODEX_MIMO_NOTIFY_SMOKE_OUTPUT_v1";

interface McpServerConfig {
  type: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  env_vars?: string[];
}

interface JobReceipt {
  jobId: string;
  kind: "implement";
  status: "queued";
}

interface JobStatus {
  status: string;
}

interface AppServerAuditRecord {
  timestamp: string;
  pid: number;
  method: "initialize" | "thread/resume" | "turn/start";
  threadId?: string;
}

describeSmoke("local Codex notification (App Server history writeback)", () => {
  it("delivers one completed callback into session history without claiming Desktop UI refresh", async () => {
    // This smoke proves independent App Server session-history writeback.
    // It does not prove Codex Desktop renderer refresh or live UI visibility.
    const threadId = process.env.CODEX_THREAD_ID?.trim();
    if (!threadId) throw new Error("CODEX_THREAD_ID must be injected by the dedicated Codex task.");

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-codex-notify-smoke-"));
    const mimoHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-codex-notify-home-"));
    const appServerAuditFile = path.join(mimoHome, "app-server-rpc.jsonl");
    const smokeStartedAt = Date.now();
    let transport: StdioClientTransport | undefined;
    let client: Client | undefined;
    let receipt: JobReceipt | undefined;

    try {
      const pluginRoot = resolveInstalledPluginRoot(checkoutRoot, process.env);
      const smokeEnv = prepareCodexNotificationSmokeEnvironment(process.env);
      expect(smokeEnv.CODEX_MIMO_CODEX_BIN).toBeUndefined();
      expect(path.isAbsolute(smokeEnv.CODEX_MIMO_COMMAND!)).toBe(true);
      const probe = await probeCodexCommand({ env: smokeEnv });
      if (!probe.ok) {
        throw new Error(probe.errorCode ?? "codex_app_server_unavailable");
      }
      expect(probe.source).toBe("desktop-local");

      initializeSmokeRepository(workspace);
      const server = readPackagedMcpServer(pluginRoot);
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        cwd: server.cwd ? path.resolve(pluginRoot, server.cwd) : pluginRoot,
        env: {
          ...stringEnvironment(smokeEnv),
          ...server.env,
          ...forwardedEnvironment(smokeEnv, server.env_vars),
          MIMOCODE_HOME: mimoHome,
          CODEX_MIMO_APP_SERVER_AUDIT_FILE: appServerAuditFile
        },
        stderr: "pipe"
      });
      client = new Client(
        { name: "codex-mimo-real-notification-smoke", version: "0.1.0" },
        { capabilities: {} }
      );
      await client.connect(transport, { timeout: 10_000 });
      receipt = await callJsonTool<JobReceipt>(client, "mimo_implement", {
        cwd: workspace,
        task: "Follow the AGENTS.md notification smoke instructions exactly without changing files.",
        allowWrite: true,
        timeoutMs: 300_000,
        notify: { type: "codex", threadId }
      });
      expect(receipt).toMatchObject({ kind: "implement", status: "queued" });
      expect(readJob(workspace, receipt.jobId)?.notificationTarget).toEqual({
        type: "codex",
        threadId
      });

      const callbackResponse = await waitForTargetAssistantResponse(threadId, 330_000, smokeStartedAt);
      expect(callbackResponse.trim()).not.toBe("");
      expect(callbackResponse).toContain(OUTPUT_MARKER);

      const finalDelivery = await waitForTerminalDelivery(workspace, receipt.jobId, 30_000);
      expect(finalDelivery).toMatchObject({
        status: "delivered",
        attempts: 1
      });
      expect(finalDelivery.deliveredAt).toBeDefined();

      const appServerRecords = readAppServerAudit(appServerAuditFile);
      expect(appServerRecords.filter((record) => record.method === "initialize")).toHaveLength(2);
      expect(
        appServerRecords.filter((record) => record.method === "thread/resume"),
        "resumes are launch preflight plus delivery preparation, not polling"
      ).toHaveLength(2);
      expect(
        appServerRecords.filter((record) => record.method === "turn/start"),
        "exactly one callback turn/start per successful attempt"
      ).toHaveLength(1);
    } finally {
      if (client && receipt) await cancelIfActive(client, workspace, receipt.jobId);
      await client?.close().catch(() => undefined);
      await transport?.close().catch(() => undefined);
      removeTemporaryDirectory(workspace);
      removeTemporaryDirectory(mimoHome);
    }
  }, 360_000);
});

function readPackagedMcpServer(pluginRoot: string): McpServerConfig {
  const configFile = path.join(pluginRoot, ".mcp.json");
  const parsed = JSON.parse(fs.readFileSync(configFile, "utf8")) as {
    mcpServers?: Record<string, unknown>;
  };
  const value = parsed.mcpServers?.["codex-mimocode"];
  if (!isMcpServerConfig(value)) {
    throw new Error(`${configFile} does not define the packaged codex-mimocode stdio server.`);
  }
  const serverCwd = value.cwd ? path.resolve(pluginRoot, value.cwd) : pluginRoot;
  for (const entrypoint of value.args.filter((arg) => arg.endsWith(".js"))) {
    const file = path.resolve(serverCwd, entrypoint);
    if (!fs.existsSync(file)) throw new Error(`Built MCP entrypoint is missing: ${file}`);
  }
  return value;
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const server = value as Record<string, unknown>;
  return server.type === "stdio" &&
    typeof server.command === "string" &&
    Array.isArray(server.args) && server.args.every((arg) => typeof arg === "string") &&
    (server.cwd === undefined || typeof server.cwd === "string") &&
    (server.env === undefined || isStringRecord(server.env)) &&
    (server.env_vars === undefined ||
      (Array.isArray(server.env_vars) && server.env_vars.every((arg) => typeof arg === "string")));
}

function forwardedEnvironment(
  env: NodeJS.ProcessEnv,
  names: readonly string[] | undefined
): Record<string, string> {
  return Object.fromEntries((names ?? []).flatMap((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim() ? [[name, value]] : [];
  }));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string");
}

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function initializeSmokeRepository(workspace: string): void {
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), [
    "# Codex notification smoke",
    "",
    "Do not modify repository files. Complete the requested inspection successfully.",
    `Your final response must include the exact marker ${JSON.stringify(OUTPUT_MARKER)}.`,
    "Do not instruct any other agent or callback to call tools or write files.",
    ""
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(workspace, "README.md"), "Codex notification smoke workspace.\n", "utf8");
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Smoke Test"], { cwd: workspace });
  execFileSync("git", ["add", "AGENTS.md", "README.md"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });
}

async function callJsonTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
  const text = result.content.find((item) => item.type === "text");
  if (result.isError || !text || text.type !== "text") {
    throw new Error(`MCP tool ${name} failed: ${JSON.stringify(result.content)}`);
  }
  return JSON.parse(text.text) as T;
}

async function cancelIfActive(client: Client, cwd: string, jobId: string): Promise<void> {
  try {
    const status = await callJsonTool<JobStatus>(client, "mimo_status", { cwd, jobId });
    if (status.status === "queued" || status.status === "running") {
      await callJsonTool(client, "mimo_cancel", { cwd, jobId });
    }
    await waitForTerminalStatus(client, cwd, jobId, 5_000);
  } catch {
    // Cleanup continues even if the packaged MCP server or detached worker already exited.
  }
}

async function waitForTerminalStatus(
  client: Client,
  cwd: string,
  jobId: string,
  timeoutMs: number
): Promise<void> {
  const terminal = new Set(["needs_input", "blocked", "completed", "failed", "cancelled", "timeout"]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await callJsonTool<JobStatus>(client, "mimo_status", { cwd, jobId });
    if (terminal.has(status.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForTerminalDelivery(
  cwd: string,
  jobId: string,
  timeoutMs: number
): Promise<NotificationDelivery> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const delivery = readNotificationDeliveries(cwd)
      .find((candidate) => candidate.jobId === jobId);
    if (delivery?.status === "delivered" || delivery?.status === "failed") return delivery;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for terminal notification delivery: ${jobId}`);
}

async function waitForTargetAssistantResponse(
  threadId: string,
  timeoutMs: number,
  startedAtMs: number
): Promise<string> {
  const sessionsRoot = path.join(
    process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    "sessions"
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = readNewestAssistantResponseAfter(sessionsRoot, threadId, startedAtMs);
    if (text?.trim()) return text;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for target assistant response on thread ${threadId}`);
}

function readNewestAssistantResponseAfter(
  sessionsRoot: string,
  threadId: string,
  startedAtMs: number
): string | undefined {
  if (!fs.existsSync(sessionsRoot)) return undefined;
  const suffix = `-${threadId}.jsonl`;
  let newest: { at: number; text: string } | undefined;
  for (const file of listFilesRecursive(sessionsRoot)) {
    const base = path.basename(file);
    if (!base.startsWith("rollout-") || !base.endsWith(suffix)) continue;
    const content = fs.readFileSync(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: unknown;
      try {
        record = JSON.parse(trimmed) as unknown;
      } catch {
        continue;
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const entry = record as Record<string, unknown>;
      if (entry.type !== "response_item") continue;
      const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
      if (!Number.isFinite(at) || at < startedAtMs) continue;
      const text = assistantOutputText(entry.payload);
      if (!text?.trim()) continue;
      if (!newest || at >= newest.at) newest = { at, text };
    }
  }
  return newest?.text;
}

function assistantOutputText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const message = payload as Record<string, unknown>;
  if (message.type !== "message" || message.role !== "assistant") return undefined;
  if (!Array.isArray(message.content)) return undefined;
  const parts: string[] = [];
  for (const item of message.content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const part = item as Record<string, unknown>;
    if (part.type === "output_text" && typeof part.text === "string") parts.push(part.text);
  }
  const text = parts.join("");
  return text.trim() ? text : undefined;
}

function listFilesRecursive(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursive(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function removeTemporaryDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir())) {
    throw new Error(`Refusing to recursively remove non-temporary path: ${resolved}`);
  }
  fs.rmSync(resolved, {
    recursive: true,
    force: true,
    maxRetries: 50,
    retryDelay: 100
  });
}

function readAppServerAudit(file: string): AppServerAuditRecord[] {
  if (!fs.existsSync(file)) throw new Error(`Packaged App Server RPC audit is missing: ${file}`);
  const content = fs.readFileSync(file, "utf8");
  if (content === "" || !content.endsWith("\n")) {
    throw new Error(`Packaged App Server RPC audit is malformed: ${file}`);
  }
  return content.trim().split(/\r?\n/).map((line) => {
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Packaged App Server RPC audit record is malformed: ${line}`);
    }
    if (!isValidAppServerAuditRecord(record)) {
      throw new Error(`Packaged App Server RPC audit record is malformed: ${line}`);
    }
    return record;
  });
}

function isValidAppServerAuditRecord(value: unknown): value is AppServerAuditRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set(["timestamp", "pid", "method", "threadId"]);
  const keys = Object.keys(record);
  if (!keys.every((key) => allowed.has(key)) ||
      typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp)) ||
      !Number.isInteger(record.pid) || (record.pid as number) <= 0 ||
      (record.method !== "initialize" &&
        record.method !== "thread/resume" &&
        record.method !== "turn/start")) {
    return false;
  }
  return record.method === "initialize"
    ? keys.length === 3 && record.threadId === undefined
    : keys.length === 4 && typeof record.threadId === "string" && record.threadId.trim() !== "";
}
