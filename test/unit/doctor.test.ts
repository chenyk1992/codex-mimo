import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MIMO_TOOL_NAMES } from "../../src/codex/tool-names.js";
import { formatDoctorReport, runDoctor } from "../../src/cli/doctor.js";

function createPluginRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "codex-mimo-doctor-"));
  mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
  mkdirSync(path.join(root, "skills", "mimocode"), { recursive: true });
  mkdirSync(path.join(root, "dist", "codex"), { recursive: true });

  writeFileSync(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "codex-mimocode",
    version: "0.1.0",
    skills: "./skills/",
    mcpServers: "./.mcp.json"
  }));
  writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "codex-mimocode": {
        type: "stdio",
        command: "node",
        args: ["dist/codex/mcp-server.js"],
        cwd: "."
      }
    }
  }));
  writeFileSync(path.join(root, "skills", "mimocode", "SKILL.md"), "---\nname: mimocode\ndescription: test\n---\n");
  writeFileSync(path.join(root, "dist", "codex", "mcp-server.js"), "export {};\n");
  return root;
}

describe("codex-mimo doctor", () => {
  it("reports the expected mimo tools when the MCP server lists them", async () => {
    const pluginRoot = createPluginRoot();
    const result = await runDoctor(
      { cwd: "/project", pluginRoot },
      {
        checkMimoVersion: vi.fn().mockResolvedValue({ ok: true, version: "mimo 0.5.0" }),
        probeMcpTools: vi.fn().mockResolvedValue([...MIMO_TOOL_NAMES])
      }
    );

    expect(result.ok).toBe(true);
    expect(result.mcpProbe.ok).toBe(true);
    expect(result.mcpProbe.missingTools).toEqual([]);
    expect(formatDoctorReport(result)).toContain("MCP tools: ok");
  });

  it("marks the report failed when required mimo tools are missing", async () => {
    const pluginRoot = createPluginRoot();
    const result = await runDoctor(
      { cwd: "/project", pluginRoot },
      {
        checkMimoVersion: vi.fn().mockResolvedValue({ ok: true, version: "mimo 0.5.0" }),
        probeMcpTools: vi.fn().mockResolvedValue(["mimo_healthcheck"])
      }
    );

    expect(result.ok).toBe(false);
    expect(result.mcpProbe.ok).toBe(false);
    expect(result.mcpProbe.missingTools).toContain("mimo_plan");
    expect(formatDoctorReport(result)).toContain("If Codex cannot see mimo_* tools");
  });

  it("marks the report failed when the MCP server exposes a legacy extra tool", async () => {
    const pluginRoot = createPluginRoot();
    const result = await runDoctor(
      { cwd: "/project", pluginRoot },
      {
        checkMimoVersion: vi.fn().mockResolvedValue({ ok: true, version: "mimo 0.5.0" }),
        probeMcpTools: vi.fn().mockResolvedValue([...MIMO_TOOL_NAMES, "mimo_wake"])
      }
    );

    expect(result.ok).toBe(false);
    expect(result.mcpProbe.ok).toBe(false);
    expect(result.mcpProbe.unexpectedTools).toEqual(["mimo_wake"]);
    expect(formatDoctorReport(result)).toContain("Unexpected tools: mimo_wake");
  });

  it("redacts MCP env values from JSON-safe doctor output", async () => {
    const pluginRoot = createPluginRoot();
    writeFileSync(path.join(pluginRoot, ".mcp.json"), JSON.stringify({
      mcpServers: {
        "codex-mimocode": {
          type: "stdio",
          command: "node",
          args: ["dist/codex/mcp-server.js"],
          cwd: ".",
          env: {
            MIMO_TOKEN: "secret-token",
            MIMO_HOME: "C:/private/path"
          }
        }
      }
    }));

    const result = await runDoctor(
      { cwd: "/project", pluginRoot },
      {
        checkMimoVersion: vi.fn().mockResolvedValue({ ok: true, version: "mimo 0.5.0" }),
        probeMcpTools: vi.fn().mockResolvedValue([...MIMO_TOOL_NAMES])
      }
    );

    expect(result.mcpConfig.server).toMatchObject({
      envKeys: ["MIMO_HOME", "MIMO_TOKEN"]
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("C:/private/path");
  });
});
