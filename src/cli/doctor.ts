import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIMO_TOOL_NAMES } from "../codex/tool-names.js";
import { buildMimoProbeEnvironment, resolveMimoCommand } from "../mimo/run-json.js";
import { DOCTOR_HINT } from "./hints.js";

const MCP_SERVER_NAME = "codex-mimocode";
const DEFAULT_MCP_TIMEOUT_MS = 10_000;

export interface DoctorInput {
  cwd?: string;
  pluginRoot?: string;
  timeoutMs?: number;
}

export interface DoctorReport {
  ok: boolean;
  cwd: string;
  pluginRoot: string;
  mimoBinary: DoctorCheck;
  pluginFiles: DoctorFileCheck;
  mcpConfig: DoctorMcpConfigCheck;
  mcpProbe: DoctorMcpProbeCheck;
  hostVisibilityNote: string;
}

export interface DoctorCheck {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface DoctorFileCheck {
  ok: boolean;
  missing: string[];
}

export interface DoctorMcpConfigCheck {
  ok: boolean;
  server?: DoctorMcpServerConfig;
  error?: string;
}

export interface DoctorMcpProbeCheck {
  ok: boolean;
  tools: string[];
  expectedTools: string[];
  missingTools: string[];
  error?: string;
}

interface DoctorMcpServerConfig {
  type: string;
  command: string;
  args: string[];
  cwd?: string;
  envKeys?: string[];
}

interface McpServerConfig {
  type: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface DoctorDeps {
  checkMimoVersion?: (cwd: string) => Promise<DoctorCheck>;
  probeMcpTools?: (pluginRoot: string, server: McpServerConfig, timeoutMs: number) => Promise<string[]>;
}

interface RawMcpConfigCheck {
  ok: boolean;
  server?: McpServerConfig;
  report: DoctorMcpConfigCheck;
}

export async function runDoctor(input: DoctorInput = {}, deps: DoctorDeps = {}): Promise<DoctorReport> {
  const cwd = input.cwd ?? process.cwd();
  const pluginRoot = input.pluginRoot ?? findPackageRoot();
  const timeoutMs = input.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const checkMimoVersion = deps.checkMimoVersion ?? defaultCheckMimoVersion;
  const probeMcpTools = deps.probeMcpTools ?? defaultProbeMcpTools;

  const mimoBinary = await checkMimoVersion(cwd);
  const pluginFiles = checkPluginFiles(pluginRoot);
  const rawMcpConfig = readMcpConfig(pluginRoot);
  const mcpProbe = await probeToolsIfPossible(pluginRoot, rawMcpConfig, timeoutMs, probeMcpTools);

  return {
    ok: mimoBinary.ok && pluginFiles.ok && rawMcpConfig.ok && mcpProbe.ok,
    cwd,
    pluginRoot,
    mimoBinary,
    pluginFiles,
    mcpConfig: rawMcpConfig.report,
    mcpProbe,
    hostVisibilityNote: "doctor probes the plugin MCP server; it cannot prove the current Codex thread has injected these tools."
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `Doctor: ${report.ok ? "ok" : "failed"}`,
    `Project cwd: ${report.cwd}`,
    `Plugin root: ${report.pluginRoot}`,
    `MiMo binary: ${report.mimoBinary.ok ? `ok (${report.mimoBinary.version ?? "version unknown"})` : `failed (${report.mimoBinary.error ?? "unknown error"})`}`,
    `Plugin files: ${report.pluginFiles.ok ? "ok" : `failed (missing ${report.pluginFiles.missing.join(", ")})`}`,
    `MCP config: ${report.mcpConfig.ok ? "ok" : `failed (${report.mcpConfig.error ?? "unknown error"})`}`,
    `MCP tools: ${report.mcpProbe.ok ? "ok" : "failed"}`
  ];

  if (report.mcpProbe.tools.length > 0) {
    lines.push(`Listed tools: ${report.mcpProbe.tools.join(", ")}`);
  }
  if (report.mcpProbe.missingTools.length > 0) {
    lines.push(`Missing tools: ${report.mcpProbe.missingTools.join(", ")}`);
  }
  if (report.mcpProbe.error) {
    lines.push(`MCP probe error: ${report.mcpProbe.error}`);
  }

  lines.push(`Note: ${report.hostVisibilityNote}`);
  if (!report.ok) {
    lines.push(`Hint: ${DOCTOR_HINT}`);
  }

  return lines.join("\n");
}

export function findPackageRoot(startUrl = import.meta.url): string {
  let current = path.dirname(fileURLToPath(startUrl));
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

async function defaultCheckMimoVersion(cwd: string): Promise<DoctorCheck> {
  try {
    const result = await execa(resolveMimoCommand(), ["--version"], {
      cwd,
      env: buildMimoProbeEnvironment(cwd),
      reject: false
    });
    if (result.exitCode !== 0) {
      return { ok: false, error: result.stderr || result.stdout || `exit ${result.exitCode}` };
    }
    return { ok: true, version: result.stdout.trim() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function checkPluginFiles(pluginRoot: string): DoctorFileCheck {
  const required = [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "skills/mimocode/SKILL.md",
    "dist/codex/mcp-server.js"
  ];
  const missing = required.filter((file) => !fs.existsSync(path.join(pluginRoot, file)));
  return { ok: missing.length === 0, missing };
}

function readMcpConfig(pluginRoot: string): RawMcpConfigCheck {
  try {
    const raw = fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf-8");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    const server = parsed.mcpServers?.[MCP_SERVER_NAME];
    if (!isMcpServerConfig(server)) {
      return {
        ok: false,
        report: { ok: false, error: `.mcp.json must define ${MCP_SERVER_NAME} stdio server` }
      };
    }
    if (server.type !== "stdio") {
      return {
        ok: false,
        report: { ok: false, error: `${MCP_SERVER_NAME} type must be "stdio"` }
      };
    }
    return {
      ok: true,
      server,
      report: { ok: true, server: sanitizeMcpServerConfig(server) }
    };
  } catch (error) {
    return {
      ok: false,
      report: { ok: false, error: error instanceof Error ? error.message : String(error) }
    };
  }
}

async function probeToolsIfPossible(
  pluginRoot: string,
  mcpConfig: RawMcpConfigCheck,
  timeoutMs: number,
  probeMcpTools: DoctorDeps["probeMcpTools"]
): Promise<DoctorMcpProbeCheck> {
  if (!mcpConfig.ok || !mcpConfig.server) {
    return {
      ok: false,
      tools: [],
      expectedTools: [...MIMO_TOOL_NAMES],
      missingTools: [...MIMO_TOOL_NAMES],
      error: "MCP config is invalid; skipped tools/list probe."
    };
  }
  try {
    const tools = await probeMcpTools!(pluginRoot, mcpConfig.server, timeoutMs);
    const missingTools = MIMO_TOOL_NAMES.filter((tool) => !tools.includes(tool));
    return {
      ok: missingTools.length === 0,
      tools,
      expectedTools: [...MIMO_TOOL_NAMES],
      missingTools
    };
  } catch (error) {
    return {
      ok: false,
      tools: [],
      expectedTools: [...MIMO_TOOL_NAMES],
      missingTools: [...MIMO_TOOL_NAMES],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function defaultProbeMcpTools(pluginRoot: string, server: McpServerConfig, timeoutMs: number): Promise<string[]> {
  const client = new Client({ name: "codex-mimo-doctor", version: "0.1.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: server.cwd ? path.resolve(pluginRoot, server.cwd) : pluginRoot,
    env: server.env,
    stderr: "pipe"
  });

  try {
    await client.connect(transport, { timeout: timeoutMs });
    const listed = await client.listTools(undefined, { timeout: timeoutMs });
    return listed.tools.map((tool) => tool.name).sort();
  } finally {
    await client.close().catch(() => undefined);
  }
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== "object") return false;
  const server = value as Record<string, unknown>;
  return (
    typeof server.type === "string" &&
    typeof server.command === "string" &&
    Array.isArray(server.args) &&
    server.args.every((arg) => typeof arg === "string") &&
    (server.cwd === undefined || typeof server.cwd === "string") &&
    (server.env === undefined || isStringRecord(server.env))
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

function sanitizeMcpServerConfig(server: McpServerConfig): DoctorMcpServerConfig {
  return {
    type: server.type,
    command: server.command,
    args: [...server.args],
    ...(server.cwd ? { cwd: server.cwd } : {}),
    ...(server.env ? { envKeys: Object.keys(server.env).sort() } : {})
  };
}
