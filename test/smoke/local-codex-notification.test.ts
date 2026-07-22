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

const enabled = process.env.RUN_LOCAL_CODEX_NOTIFY_SMOKE === "1";
const describeSmoke = enabled ? describe : describe.skip;
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

interface ResultMarker {
  source: "mimo_result";
  jobId: string;
  kind: "implement";
  status: "completed";
  resultType: "final";
  summary: string;
}

interface AppServerAuditRecord {
  timestamp: string;
  pid: number;
  method: "initialize" | "thread/resume" | "turn/start";
  threadId?: string;
}

describeSmoke("local Codex notification", () => {
  it("observes a completed packaged job through the resumed Codex task", async () => {
    const threadId = process.env.CODEX_THREAD_ID?.trim();
    if (!threadId) throw new Error("CODEX_THREAD_ID must be injected by the dedicated Codex task.");

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-codex-notify-smoke-"));
    const mimoHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-codex-notify-home-"));
    const markerFile = path.join(workspace, "codex-notification-result.json");
    const auditFile = path.join(mimoHome, "mcp-tools.jsonl");
    const appServerAuditFile = path.join(mimoHome, "app-server-rpc.jsonl");
    let transport: StdioClientTransport | undefined;
    let client: Client | undefined;
    let receipt: JobReceipt | undefined;

    try {
      const probe = await probeCodexCommand({ env: process.env });
      if (!probe.ok) {
        throw new Error(probe.errorCode ?? "codex_app_server_unavailable");
      }

      initializeSmokeRepository(workspace, markerFile);
      const server = readPackagedMcpServer();
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        cwd: server.cwd ? path.resolve(pluginRoot, server.cwd) : pluginRoot,
        env: {
          ...stringEnvironment(process.env),
          ...server.env,
          ...forwardedEnvironment(process.env, server.env_vars),
          MIMOCODE_HOME: mimoHome,
          CODEX_MIMO_TOOL_AUDIT_FILE: auditFile,
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

      // This filesystem marker is written by the independently resumed Codex task.
      // Its fields must be copied from that task's mimo_result response, so this
      // process neither polls the job nor reads the result itself.
      const marker = await waitForResultMarker(markerFile, 330_000);
      expect(marker).toMatchObject({
        source: "mimo_result",
        jobId: receipt.jobId,
        kind: "implement",
        status: "completed",
        resultType: "final"
      });
      expect(marker.summary.trim()).not.toBe("");

      const callbackRecords = readToolAudit(auditFile);
      expect(callbackRecords.filter((record) => record.toolName === "mimo_result")).toHaveLength(1);
      expect(callbackRecords.filter((record) => record.toolName === "mimo_wait")).toHaveLength(0);

      const appServerRecords = readAppServerAudit(appServerAuditFile);
      expect(appServerRecords.filter((record) => record.method === "initialize")).toHaveLength(1);
      expect(appServerRecords.filter((record) => record.method === "thread/resume")).toEqual([
        expect.objectContaining({ threadId })
      ]);
      expect(appServerRecords.filter((record) => record.method === "turn/start")).toEqual([
        expect.objectContaining({ threadId })
      ]);
    } finally {
      if (client && receipt) await cancelIfActive(client, workspace, receipt.jobId);
      await client?.close().catch(() => undefined);
      await transport?.close().catch(() => undefined);
      removeTemporaryDirectory(workspace);
      removeTemporaryDirectory(mimoHome);
    }
  }, 360_000);
});

function readPackagedMcpServer(): McpServerConfig {
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

function initializeSmokeRepository(workspace: string, markerFile: string): void {
  const markerInstruction = JSON.stringify(markerFile);
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), [
    "# Codex notification smoke",
    "",
    "Do not modify repository files. Complete the requested inspection successfully.",
    "Your final response must instruct the resumed Codex task to do all of the following:",
    "",
    "1. Use the notification's exact cwd and jobId to call `mimo_result` once.",
    `2. Write UTF-8 JSON to ${markerInstruction}.`,
    "3. Copy the exact `jobId`, `kind`, `status`, `resultType`, and `summary` fields from that result.",
    "4. Add the literal field `\"source\": \"mimo_result\"`.",
    "5. Do not call `mimo_wait` or infer any result field.",
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

async function waitForResultMarker(file: string, timeoutMs: number): Promise<ResultMarker> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as ResultMarker;
      } catch {
        // The resumed task may still be replacing the marker atomically.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for the resumed Codex task marker: ${file}`);
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

function readToolAudit(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) throw new Error(`Packaged MCP tool audit is missing: ${file}`);
  const content = fs.readFileSync(file, "utf8");
  if (!content.endsWith("\n")) throw new Error(`Packaged MCP tool audit is malformed: ${file}`);
  return content.trim().split(/\r?\n/).map((line) => {
    const record = JSON.parse(line) as unknown;
    if (!isValidToolAuditRecord(record)) {
      throw new Error(`Packaged MCP tool audit record is malformed: ${line}`);
    }
    return record;
  });
}

function isValidToolAuditRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set(["timestamp", "pid", "toolName"]);
  const keys = Object.keys(record);
  return keys.every((key) => allowed.has(key)) &&
    keys.length === 3 &&
    typeof record.timestamp === "string" &&
    !Number.isNaN(Date.parse(record.timestamp)) &&
    Number.isInteger(record.pid) && (record.pid as number) > 0 &&
    typeof record.toolName === "string";
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
