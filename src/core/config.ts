import fs from "node:fs";
import path from "node:path";
import { type BridgePolicy, defaultPolicy } from "./policy.js";

export interface ConfigFile {
  workspaceRoot?: string;
  fileAccess?: {
    read?: string[];
    write?: string[];
    deny?: string[];
  };
  terminal?: {
    allow?: string[];
    ask?: string[];
    deny?: string[];
  };
  ci?: {
    enabled?: boolean;
    denyAllAsks?: boolean;
  };
  audit?: {
    maxFileSize?: number;
    maxFiles?: number;
  };
  mcpServers?: {
    allowlist?: string[];
  };
}

export function loadConfig(cwd: string): ConfigFile {
  const configPath = path.join(cwd, "codex-mimo.config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as ConfigFile;
  } catch {
    return {};
  }
}

export function configToPolicy(cwd: string, config: ConfigFile, ciMode?: boolean): BridgePolicy {
  const base = defaultPolicy(config.workspaceRoot ?? cwd);

  if (config.terminal) {
    if (config.terminal.allow) base.allowedCommands = config.terminal.allow;
    if (config.terminal.ask) base.askCommands = config.terminal.ask;
    if (config.terminal.deny) base.deniedCommands = config.terminal.deny;
  }

  if (config.fileAccess) {
    if (config.fileAccess.deny) base.deniedFileGlobs = config.fileAccess.deny;
    if (config.fileAccess.read) base.allowedReadGlobs = config.fileAccess.read;
    if (config.fileAccess.write) base.allowedWriteGlobs = config.fileAccess.write;
  }

  base.ciMode = ciMode ?? config.ci?.enabled ?? false;

  return base;
}
