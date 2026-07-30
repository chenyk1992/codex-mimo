import { pathToFileURL } from "node:url";
import { CODEX_MIMO_READONLY_AGENT } from "../core/safety-contracts.js";

const READONLY_AGENT_CONFIG = {
  mode: "primary",
  description: "Codex-MiMo read-only execution policy.",
  tool_allowlist: [
    "read",
    "glob",
    "grep",
    "list",
    "lsp",
    "webfetch",
    "websearch",
    "codesearch",
    "skill",
    "view_image"
  ],
  permission: {
    "*": "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    lsp: "allow",
    webfetch: "allow",
    websearch: "allow",
    codesearch: "allow",
    skill: { "compose:*": "allow" },
    view_image: "allow"
  }
} as const;

const BRIDGE_MCP_NAME = "codex-mimocode";

export interface BridgeRuntimeConfigOptions {
  allowExternalDirectory?: boolean;
}

export function buildBridgeRuntimeConfig(
  pluginFile?: string,
  options: BridgeRuntimeConfigOptions = {}
): Record<string, unknown> {
  return {
    dream: { auto: false },
    distill: { auto: false },
    ...(options.allowExternalDirectory
      ? { permission: { external_directory: "allow" } }
      : {}),
    mcp: {
      [BRIDGE_MCP_NAME]: { enabled: false }
    },
    agent: {
      [CODEX_MIMO_READONLY_AGENT]: READONLY_AGENT_CONFIG
    },
    ...(pluginFile ? { plugin: [pathToFileURL(pluginFile).href] } : {})
  };
}

export function buildBridgeRuntimeEnvironment(
  pluginFile?: string,
  env: NodeJS.ProcessEnv = process.env,
  options: BridgeRuntimeConfigOptions = {}
): NodeJS.ProcessEnv {
  const bridge = buildBridgeRuntimeConfig(pluginFile, options);
  const existing = parseExistingConfigContent(env.MIMOCODE_CONFIG_CONTENT);
  const existingAgents = isRecord(existing.agent) ? existing.agent : {};
  const existingMcp = isRecord(existing.mcp) ? existing.mcp : {};
  const existingPlugins = Array.isArray(existing.plugin) ? existing.plugin : [];
  const existingPermission = isRecord(existing.permission) ? existing.permission : {};

  return {
    MIMOCODE_CONFIG_CONTENT: JSON.stringify({
      ...existing,
      dream: { ...(isRecord(existing.dream) ? existing.dream : {}), auto: false },
      distill: { ...(isRecord(existing.distill) ? existing.distill : {}), auto: false },
      ...(options.allowExternalDirectory
        ? {
            permission: {
              ...existingPermission,
              external_directory: "allow"
            }
          }
        : {}),
      mcp: {
        ...existingMcp,
        [BRIDGE_MCP_NAME]: { enabled: false }
      },
      agent: {
        ...existingAgents,
        ...(bridge.agent as Record<string, unknown>)
      },
      ...(pluginFile
        ? { plugin: [...existingPlugins, pathToFileURL(pluginFile).href] }
        : existing.plugin === undefined
          ? {}
          : { plugin: existing.plugin })
    })
  };
}

function parseExistingConfigContent(content: string | undefined): Record<string, unknown> {
  if (!content?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      "MIMOCODE_CONFIG_CONTENT must be valid JSON so codex-mimo can preserve it while adding run-scoped safety policy."
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("MIMOCODE_CONFIG_CONTENT must contain a JSON object.");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
