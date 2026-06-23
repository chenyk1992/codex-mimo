import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, configToPolicy } from "../../../src/core/config.js";

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-config-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("config loading", () => {
  it("5.9: valid config merges into policy", () => {
    const cwd = tempWorkspace();
    const configData = {
      terminal: {
        allow: ["git status*", "npm test*"],
        ask: ["npm install*"],
        deny: ["rm *"]
      },
      fileAccess: {
        deny: ["**/.env", "**/.env.*"],
        read: ["**/*.ts"],
        write: ["**/*.ts"]
      }
    };
    fs.writeFileSync(path.join(cwd, "codex-mimo.config.json"), JSON.stringify(configData), "utf-8");

    const config = loadConfig(cwd);
    const policy = configToPolicy(cwd, config);

    expect(policy.allowedCommands).toEqual(["git status*", "npm test*"]);
    expect(policy.askCommands).toEqual(["npm install*"]);
    expect(policy.deniedCommands).toEqual(["rm *"]);
    expect(policy.deniedFileGlobs).toEqual(["**/.env", "**/.env.*"]);
    expect(policy.allowedReadGlobs).toEqual(["**/*.ts"]);
    expect(policy.allowedWriteGlobs).toEqual(["**/*.ts"]);
  });

  it("5.10: missing config → empty object", () => {
    const cwd = tempWorkspace();
    const config = loadConfig(cwd);
    expect(config).toEqual({});
  });

  it("5.11: malformed JSON → empty object", () => {
    const cwd = tempWorkspace();
    fs.writeFileSync(path.join(cwd, "codex-mimo.config.json"), "{invalid-json", "utf-8");

    const config = loadConfig(cwd);
    expect(config).toEqual({});
  });

  it("5.12: ci.enabled=true sets ciMode", () => {
    const cwd = tempWorkspace();
    const configData = { ci: { enabled: true } };
    fs.writeFileSync(path.join(cwd, "codex-mimo.config.json"), JSON.stringify(configData), "utf-8");

    const config = loadConfig(cwd);
    const policy = configToPolicy(cwd, config);

    expect(policy.ciMode).toBe(true);
  });
});
