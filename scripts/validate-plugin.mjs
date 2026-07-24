#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const DEFAULT_SERVER_NAME = "codex-mimocode";
const DEFAULT_SERVER_ENTRY = "dist/codex/mcp-server.js";
const EXPECTED_TOOL_NAMES = [
  "mimo_healthcheck",
  "mimo_plan",
  "mimo_implement",
  "mimo_review",
  "mimo_fix_ci",
  "mimo_resume",
  "mimo_compose",
  "mimo_status",
  "mimo_events",
  "mimo_wait",
  "mimo_result",
  "mimo_cancel",
  "mimo_jobs"
];
const STRING_SCHEMA = { type: "string", minLength: 1 };
const CODEX_THREAD_ID_SCHEMA = {
  ...STRING_SCHEMA,
  description: "Originating Codex task ID"
};
const VERIFICATION_ITEM_SCHEMA = {
  ...STRING_SCHEMA,
  description: "One executable command with arguments; commands run without a shell"
};
const VERIFICATION_SCHEMA = {
  type: "array",
  items: VERIFICATION_ITEM_SCHEMA,
  description: "Executable verification commands, not natural-language acceptance criteria"
};
const NOTIFY_SCHEMA = {
  anyOf: [
    {
      type: "object",
      properties: {
        type: { type: "string", const: "codex" },
        threadId: CODEX_THREAD_ID_SCHEMA
      },
      required: ["type", "threadId"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        type: { type: "string", const: "webhook" },
        url: STRING_SCHEMA,
        secretEnv: STRING_SCHEMA
      },
      required: ["type", "url", "secretEnv"],
      additionalProperties: false
    }
  ]
};
const COMMON_JOB_PROPERTIES = {
  cwd: STRING_SCHEMA,
  model: STRING_SCHEMA,
  timeoutMs: { type: "integer", exclusiveMinimum: 0, default: 1_800_000 },
  idleTimeoutMs: { type: "integer", minimum: 0, default: 1_800_000 },
  notify: NOTIFY_SCHEMA
};

function canonicalWorkSchema(properties, required) {
  return {
    type: "object",
    properties: { ...COMMON_JOB_PROPERTIES, ...properties },
    required,
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#"
  };
}

const CANONICAL_WORK_TOOL_SCHEMAS = {
  mimo_plan: canonicalWorkSchema({ task: STRING_SCHEMA }, ["cwd", "task"]),
  mimo_implement: canonicalWorkSchema(
    { task: STRING_SCHEMA, allowWrite: { type: "boolean" } },
    ["cwd", "task", "allowWrite"]
  ),
  mimo_review: canonicalWorkSchema({ base: { ...STRING_SCHEMA, default: "HEAD" } }, ["cwd"]),
  mimo_fix_ci: canonicalWorkSchema(
    { file: STRING_SCHEMA, task: STRING_SCHEMA },
    ["cwd", "file"]
  ),
  mimo_resume: canonicalWorkSchema(
    { jobId: STRING_SCHEMA, task: STRING_SCHEMA },
    ["cwd", "jobId", "task"]
  ),
  mimo_compose: canonicalWorkSchema({
    workflow: {
      type: "string",
      enum: [
        "brainstorm", "dev", "fix", "fix-ci", "plan", "execute-plan", "review",
        "parallel", "worktree", "merge", "new-skill"
      ]
    },
    task: STRING_SCHEMA,
    file: STRING_SCHEMA,
    since: STRING_SCHEMA,
    verification: VERIFICATION_SCHEMA,
    reportDir: STRING_SCHEMA
  }, ["cwd", "workflow"])
};

function usage() {
  return [
    "Usage: node scripts/validate-plugin.mjs [--root <path>]",
    "",
    "Validates the Codex plugin manifest, MCP config, skill metadata, and built MCP entrypoint.",
    "This validator uses only Node.js built-ins; it does not require Python or PyYAML."
  ].join("\n");
}

function parseArgs(argv) {
  const args = { root: process.cwd(), help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--root requires a path");
      }
      args.root = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function toRel(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(root, relativePath, errors) {
  const fullPath = path.join(root, relativePath);
  if (!existsSync(fullPath)) {
    errors.push(`${relativePath} is missing`);
    return null;
  }

  try {
    return JSON.parse(readFileSync(fullPath, "utf8"));
  } catch (error) {
    errors.push(`${relativePath} must be valid JSON: ${error.message}`);
    return null;
  }
}

function requireString(errors, object, field, label) {
  if (typeof object[field] !== "string" || object[field].trim() === "") {
    errors.push(`${label} must define ${field}`);
    return null;
  }
  return object[field];
}

function requireStringArray(errors, value, label) {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.trim())) {
    errors.push(`${label} must be a non-empty string array`);
    return false;
  }
  return true;
}

function assertFile(root, relativePath, errors) {
  const fullPath = path.join(root, relativePath);
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    errors.push(`${relativePath} is missing`);
    return false;
  }
  return true;
}

function assertDirectory(root, relativePath, errors) {
  const fullPath = path.join(root, relativePath);
  if (!existsSync(fullPath) || !statSync(fullPath).isDirectory()) {
    errors.push(`${relativePath} is missing`);
    return false;
  }
  return true;
}

function validatePluginManifest(root, errors) {
  const plugin = readJson(root, ".codex-plugin/plugin.json", errors);
  if (!plugin) {
    return;
  }
  if (!isObject(plugin)) {
    errors.push(".codex-plugin/plugin.json must contain a JSON object");
    return;
  }

  requireString(errors, plugin, "name", ".codex-plugin/plugin.json");
  requireString(errors, plugin, "version", ".codex-plugin/plugin.json");
  requireString(errors, plugin, "description", ".codex-plugin/plugin.json");

  if (plugin.skills !== "./skills/") {
    errors.push('.codex-plugin/plugin.json skills must be "./skills/"');
  }
  if (plugin.mcpServers !== "./.mcp.json") {
    errors.push('.codex-plugin/plugin.json mcpServers must be "./.mcp.json"');
  }

  if (!isObject(plugin.interface)) {
    errors.push(".codex-plugin/plugin.json interface must be an object");
    return;
  }

  requireString(errors, plugin.interface, "displayName", ".codex-plugin/plugin.json interface");
  requireString(errors, plugin.interface, "shortDescription", ".codex-plugin/plugin.json interface");
  requireString(errors, plugin.interface, "developerName", ".codex-plugin/plugin.json interface");
  requireString(errors, plugin.interface, "category", ".codex-plugin/plugin.json interface");
  requireStringArray(errors, plugin.interface.capabilities, ".codex-plugin/plugin.json interface capabilities");

  if (typeof plugin.interface.brandColor !== "string" || !/^#[0-9a-fA-F]{6}$/.test(plugin.interface.brandColor)) {
    errors.push(".codex-plugin/plugin.json interface brandColor must be a #RRGGBB color");
  }
}

function validateMcpConfig(root, errors) {
  const mcp = readJson(root, ".mcp.json", errors);
  if (!mcp) {
    return;
  }
  if (!isObject(mcp) || !isObject(mcp.mcpServers)) {
    errors.push(".mcp.json must define an mcpServers object");
    return;
  }

  const server = mcp.mcpServers[DEFAULT_SERVER_NAME];
  if (!isObject(server)) {
    errors.push(`.mcp.json mcpServers must define ${DEFAULT_SERVER_NAME}`);
    return;
  }

  if (server.type !== "stdio") {
    errors.push(`${DEFAULT_SERVER_NAME} MCP server type must be "stdio"`);
  }
  if (server.command !== "node") {
    errors.push(`${DEFAULT_SERVER_NAME} MCP server command must be "node"`);
  }
  if (server.cwd !== ".") {
    errors.push(`${DEFAULT_SERVER_NAME} MCP server cwd must be "."`);
  }
  if (!requireStringArray(errors, server.args, `${DEFAULT_SERVER_NAME} MCP server args`)) {
    return;
  }
  if (!server.args.includes(DEFAULT_SERVER_ENTRY)) {
    errors.push(`${DEFAULT_SERVER_NAME} MCP server args must include ${DEFAULT_SERVER_ENTRY}`);
    return;
  }

  const envVars = server.env_vars;
  if (!Array.isArray(envVars) || envVars.length !== 1 || envVars[0] !== "CODEX_MIMO_CODEX_BIN") {
    errors.push(`${DEFAULT_SERVER_NAME} MCP server must forward CODEX_MIMO_CODEX_BIN through env_vars`);
  }
  if (Array.isArray(envVars) && envVars.includes("CODEX_THREAD_ID")) {
    errors.push(`${DEFAULT_SERVER_NAME} MCP server must not forward CODEX_THREAD_ID through env_vars`);
  }
  if (isObject(server.env)) {
    if ("CODEX_THREAD_ID" in server.env) {
      errors.push(`${DEFAULT_SERVER_NAME} MCP server must not set CODEX_THREAD_ID statically`);
    }
    if ("CODEX_MIMO_CODEX_BIN" in server.env) {
      errors.push(`${DEFAULT_SERVER_NAME} MCP server must not set CODEX_MIMO_CODEX_BIN statically`);
    }
  }

  assertFile(root, DEFAULT_SERVER_ENTRY, errors);
}

function parseFrontmatter(content) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    return { error: "must start with frontmatter" };
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex === -1) {
    return { error: "frontmatter must close with ---" };
  }

  const values = {};
  for (const line of lines.slice(1, endIndex)) {
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      return { error: `frontmatter line is not supported: ${line}` };
    }

    const [, key, rawValue] = match;
    values[key] = rawValue.trim().replace(/^(['"])(.*)\1$/, "$2");
  }

  return {
    values,
    body: lines.slice(endIndex + 1).join("\n").trim()
  };
}

function validateSkill(root, skillDir, errors) {
  const skillFile = path.join(skillDir, "SKILL.md");
  const relativeSkillFile = toRel(root, skillFile);

  if (!existsSync(skillFile) || !statSync(skillFile).isFile()) {
    errors.push(`${relativeSkillFile} is missing`);
    return;
  }

  const content = readFileSync(skillFile, "utf8");
  const parsed = parseFrontmatter(content);
  if (parsed.error) {
    errors.push(`${relativeSkillFile} ${parsed.error}`);
    return;
  }

  const skillName = path.basename(skillDir);
  if (typeof parsed.values.name !== "string" || parsed.values.name.trim() === "") {
    errors.push(`${relativeSkillFile} frontmatter must define name`);
  } else if (parsed.values.name !== skillName) {
    errors.push(`${relativeSkillFile} frontmatter name must match directory name ${skillName}`);
  }

  if (typeof parsed.values.description !== "string" || parsed.values.description.trim() === "") {
    errors.push(`${relativeSkillFile} frontmatter must define description`);
  }

  if (!parsed.body) {
    errors.push(`${relativeSkillFile} must include skill instructions after frontmatter`);
  }
  if (/\b(?:loop|poll|frequent(?:ly)?|repeat(?:ed|edly)?)\b[^\n.]{0,100}\bmimo_wait\b|\bmimo_wait\b[^\n.]{0,100}\b(?:loop|poll|frequent(?:ly)?|repeat(?:ed|edly)?)\b/i.test(parsed.body)) {
    errors.push(`${relativeSkillFile} must not instruct Codex to poll or loop on mimo_wait`);
  }
  if (skillName === "mimocode") {
    if (!/companion/i.test(parsed.body) || !/mimo_result/i.test(parsed.body)) {
      errors.push(`${relativeSkillFile} must document companion wake path using mimo_result`);
    }
    if (!/without companion|no companion|without the companion/i.test(parsed.body)) {
      errors.push(`${relativeSkillFile} must document the no-companion demotion path`);
    }
    if (!/heartbeat|scheduled follow-up|in-chat scheduled/i.test(parsed.body)) {
      errors.push(`${relativeSkillFile} must document Codex Desktop in-chat heartbeat follow-up`);
    }
    if (/Every Codex Desktop work launch must send `notify/i.test(parsed.body)) {
      errors.push(`${relativeSkillFile} must not require Desktop notify as the primary wait path`);
    }
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function validateSkills(root, errors) {
  if (!assertDirectory(root, "skills", errors)) {
    return;
  }

  const skillsDir = path.join(root, "skills");
  const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsDir, entry.name));

  if (skillDirs.length === 0) {
    errors.push("skills must contain at least one skill directory");
    return;
  }

  for (const skillDir of skillDirs) {
    validateSkill(root, skillDir, errors);
  }
}

async function validateBuiltTools(root, errors) {
  const mcp = readJson(root, ".mcp.json", errors);
  const server = mcp?.mcpServers?.[DEFAULT_SERVER_NAME];
  if (!isObject(server) || typeof server.command !== "string" || !Array.isArray(server.args)) return;

  let child;
  try {
    child = spawn(server.command, server.args, {
      cwd: path.resolve(root, typeof server.cwd === "string" ? server.cwd : "."),
      env: { ...process.env, ...(isObject(server.env) ? server.env : {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
  } catch (error) {
    errors.push(`built MCP server could not start: ${error.message}`);
    return;
  }

  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        message.error ? waiter.reject(new Error(message.error.message ?? "MCP error")) : waiter.resolve(message.result);
      }
    } catch {}
  });

  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out waiting for ${method}`));
    }, 5_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  try {
    await request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "codex-mimo-plugin-validator", version: "1" }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    const result = await request(2, "tools/list", {});
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    const names = tools.map((tool) => tool?.name).filter((name) => typeof name === "string");
    if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOL_NAMES)) {
      errors.push(`built MCP server must expose exactly the 13 supported tools in canonical order; found: ${names.join(", ")}`);
    }
    for (const [name, expectedSchema] of Object.entries(CANONICAL_WORK_TOOL_SCHEMAS)) {
      const tool = tools.find((candidate) => candidate?.name === name);
      if (stableJson(tool?.inputSchema) !== stableJson(expectedSchema)) {
        errors.push(`${name} input schema must match the canonical contract`);
      }
    }
  } catch (error) {
    errors.push(`built MCP tool inspection failed: ${error.message}${stderr.trim() ? ` (${stderr.trim()})` : ""}`);
  } finally {
    for (const waiter of pending.values()) waiter.reject(new Error("MCP probe closed"));
    pending.clear();
    lines.close();
    child.stdin.destroy();
    child.kill();
  }
}

export async function validatePlugin(rootDir = process.cwd()) {
  const root = path.resolve(rootDir);
  const errors = [];

  assertFile(root, ".codex-plugin/plugin.json", errors);
  assertFile(root, ".mcp.json", errors);
  validatePluginManifest(root, errors);
  validateMcpConfig(root, errors);
  validateSkills(root, errors);
  if (errors.length === 0) await validateBuiltTools(root, errors);

  return {
    ok: errors.length === 0,
    root,
    errors
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const result = await validatePlugin(args.root);
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(error);
    }
    return 1;
  }

  console.log(`Plugin validation passed: ${result.root}`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
