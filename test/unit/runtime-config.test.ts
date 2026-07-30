import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildBridgeRuntimeConfig,
  buildBridgeRuntimeEnvironment
} from "../../src/mimo/runtime-config.js";

describe("bridge runtime config", () => {
  it("defines read-only execution policy without selecting a model or provider", () => {
    const config = buildBridgeRuntimeConfig();

    expect(config).toMatchObject({
      mcp: {
        "codex-mimocode": { enabled: false }
      },
      agent: {
        "codex-mimo-readonly": {
          mode: "primary",
          permission: { "*": "deny", read: "allow" }
        }
      }
    });
    expect(JSON.stringify(config)).not.toMatch(/model|provider/i);
  });

  it("preserves MiMoCode-owned config content while adding run-scoped policy and plugin", () => {
    const pluginFile = "E:\\runtime\\callback.js";
    const result = buildBridgeRuntimeEnvironment(pluginFile, {
      MIMOCODE_CONFIG_CONTENT: JSON.stringify({
        model: "user-owned/model",
        provider: { "user-owned": { api: "https://example.test" } },
        mcp: {
          "user-owned": {
            type: "remote",
            url: "https://mcp.example.test"
          },
          "codex-mimocode": {
            type: "local",
            command: ["node", "user-owned-bridge.js"],
            enabled: true
          }
        },
        agent: { custom: { mode: "primary" } },
        plugin: ["existing-plugin"]
      }),
      MIMOCODE_CONFIG_DIR: "E:\\user-owned-config"
    });
    const config = JSON.parse(result.MIMOCODE_CONFIG_CONTENT!);

    expect(config).toMatchObject({
      model: "user-owned/model",
      provider: { "user-owned": { api: "https://example.test" } },
      mcp: {
        "user-owned": {
          type: "remote",
          url: "https://mcp.example.test"
        },
        "codex-mimocode": { enabled: false }
      },
      agent: {
        custom: { mode: "primary" },
        "codex-mimo-readonly": { mode: "primary" }
      }
    });
    expect(config.plugin).toEqual(["existing-plugin", pathToFileURL(pluginFile).href]);
    expect(result).not.toHaveProperty("MIMOCODE_CONFIG_DIR");
  });

  it("allows external directories only when the worktree runtime requests it", () => {
    const base = {
      MIMOCODE_CONFIG_CONTENT: JSON.stringify({
        permission: {
          read: "allow",
          external_directory: "deny"
        }
      })
    };

    const normal = JSON.parse(
      buildBridgeRuntimeEnvironment(undefined, base).MIMOCODE_CONFIG_CONTENT!
    );
    const worktree = JSON.parse(
      buildBridgeRuntimeEnvironment(undefined, base, {
        allowExternalDirectory: true
      }).MIMOCODE_CONFIG_CONTENT!
    );

    expect(normal.permission).toEqual({
      read: "allow",
      external_directory: "deny"
    });
    expect(worktree.permission).toEqual({
      read: "allow",
      external_directory: "allow"
    });
    expect(buildBridgeRuntimeConfig()).not.toHaveProperty("permission");
    expect(buildBridgeRuntimeConfig(undefined, {
      allowExternalDirectory: true
    })).toMatchObject({
      permission: { external_directory: "allow" }
    });
  });

  it("refuses to overwrite unparseable MiMoCode config content", () => {
    expect(() => buildBridgeRuntimeEnvironment(undefined, {
      MIMOCODE_CONFIG_CONTENT: "{ // JSONC cannot be safely merged here"
    })).toThrow(/must be valid JSON/i);
  });
});
