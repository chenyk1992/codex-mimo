#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SERVER_NAME = "codex-mimocode";
const DEFAULT_SERVER_ENTRY = "dist/codex/mcp-server.js";

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

  const parsed = parseFrontmatter(readFileSync(skillFile, "utf8"));
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

export function validatePlugin(rootDir = process.cwd()) {
  const root = path.resolve(rootDir);
  const errors = [];

  assertFile(root, ".codex-plugin/plugin.json", errors);
  assertFile(root, ".mcp.json", errors);
  validatePluginManifest(root, errors);
  validateMcpConfig(root, errors);
  validateSkills(root, errors);

  return {
    ok: errors.length === 0,
    root,
    errors
  };
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const result = validatePlugin(args.root);
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
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
