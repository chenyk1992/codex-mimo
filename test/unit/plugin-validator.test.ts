import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const EXPECTED_TOOLS = [
  "mimo_healthcheck", "mimo_plan", "mimo_implement", "mimo_review", "mimo_fix_ci",
  "mimo_resume", "mimo_compose", "mimo_status", "mimo_events", "mimo_wait",
  "mimo_result", "mimo_cancel", "mimo_jobs"
] as const;

function createPluginFixture(
  skillFrontmatter: string,
  options: { toolNames?: readonly string[]; oldWorkField?: string; skillBody?: string } = {}
): string {
  const root = mkdtempSync(path.join(tmpdir(), "codex-mimo-plugin-"));

  mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
  mkdirSync(path.join(root, "skills", "mimocode"), { recursive: true });
  mkdirSync(path.join(root, "dist", "codex"), { recursive: true });

  writeFileSync(
    path.join(root, ".codex-plugin", "plugin.json"),
    JSON.stringify(
      {
        name: "codex-mimocode",
        version: "0.1.0",
        description: "Bridge test plugin",
        author: { name: "Test Team" },
        license: "MIT",
        skills: "./skills/",
        mcpServers: "./.mcp.json",
        interface: {
          displayName: "Codex MiMoCode Bridge",
          shortDescription: "Invoke MiMoCode",
          developerName: "Test Team",
          category: "Developer Tools",
          capabilities: ["Write", "Execute"],
          brandColor: "#FF6900"
        }
      },
      null,
      2
    )
  );

  writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          "codex-mimocode": {
            type: "stdio",
            command: "node",
            args: ["dist/codex/mcp-server.js"],
            cwd: ".",
            env: {}
          }
        }
      },
      null,
      2
    )
  );

  writeFileSync(
    path.join(root, "skills", "mimocode", "SKILL.md"),
    `${skillFrontmatter}\n\n# MiMoCode\n\n${options.skillBody ?? "Use MiMoCode as a specialist coding agent."}\n`
  );
  const tools = (options.toolNames ?? EXPECTED_TOOLS).map((name) => ({
    name,
    inputSchema: {
      type: "object",
      properties: {
        ...(name.startsWith("mimo_") && ["mimo_plan", "mimo_implement", "mimo_review", "mimo_fix_ci", "mimo_resume", "mimo_compose"].includes(name)
          ? { cwd: { type: "string" }, ...(options.oldWorkField ? { [options.oldWorkField]: { type: "boolean" } } : {}) }
          : {})
      }
    }
  }));
  writeFileSync(path.join(root, "dist", "codex", "mcp-server.js"), `
import readline from "node:readline";
const tools = ${JSON.stringify(tools)};
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" }
    } }) + "\\n");
  } else if (request.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools } }) + "\\n");
  }
});
`);

  return root;
}

function runValidator(root: string) {
  return spawnSync(process.execPath, ["scripts/validate-plugin.mjs", "--root", root], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

describe("lightweight plugin validator", () => {
  it("validates plugin and skill structure without Python or PyYAML", () => {
    const root = createPluginFixture("---\nname: mimocode\ndescription: Use MiMoCode.\n---");

    const result = runValidator(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Plugin validation passed");
    expect(result.stderr).toBe("");
  });

  it("fails when a skill is missing required frontmatter", () => {
    const root = createPluginFixture("---\nname: mimocode\n---");

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("skills/mimocode/SKILL.md frontmatter must define description");
  });

  it("rejects a built MCP tool list that contains a removed tool", () => {
    const root = createPluginFixture("---\nname: mimocode\ndescription: Use MiMoCode.\n---", {
      toolNames: [...EXPECTED_TOOLS.slice(0, -1), "mimo_wake"]
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exactly the 13 supported tools");
    expect(result.stderr).toContain("mimo_wake");
  });

  it.each(["background", "wait"])("rejects the removed %s work-tool field", (field) => {
    const root = createPluginFixture("---\nname: mimocode\ndescription: Use MiMoCode.\n---", {
      oldWorkField: field
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`must not expose removed field ${field}`);
  });

  it("rejects skill guidance that tells Codex to loop on mimo_wait", () => {
    const root = createPluginFixture("---\nname: mimocode\ndescription: Use MiMoCode.\n---", {
      skillBody: "Loop and call mimo_wait frequently until the work finishes."
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not instruct Codex to poll or loop on mimo_wait");
  });
});
