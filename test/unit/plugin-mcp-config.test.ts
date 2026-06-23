import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("plugin MCP configuration", () => {
  it("uses the Codex plugin MCP map shape with a stable server cwd", () => {
    const config = JSON.parse(readFileSync(".mcp.json", "utf8")) as Record<string, unknown>;

    expect(config).toHaveProperty("mcpServers");
    expect(config).not.toHaveProperty("mcp_servers");
    
    const mcpServers = config["mcpServers"] as Record<string, unknown>;
    expect(mcpServers).toHaveProperty("codex-mimocode");

    const server = mcpServers["codex-mimocode"] as Record<string, unknown>;
    expect(server.type).toBe("stdio");
    expect(server.command).toBe("node");
    expect(server.args).toEqual(["dist/codex/mcp-server.js"]);
    expect(server.cwd).toBe(".");
  });
});
