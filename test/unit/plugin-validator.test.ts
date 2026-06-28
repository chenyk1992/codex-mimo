import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function createPluginFixture(skillFrontmatter: string): string {
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
    `${skillFrontmatter}\n\n# MiMoCode\n\nUse MiMoCode as a specialist coding agent.\n`
  );
  writeFileSync(path.join(root, "dist", "codex", "mcp-server.js"), "export {};\n");

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
});
