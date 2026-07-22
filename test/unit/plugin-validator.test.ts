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

const VALID_MIMOCODE_SKILL_BODY = [
  "### Cursor with companion",
  "The companion stop hook blocks until attention; on follow-up call mimo_result with the jobId.",
  "### Cursor without companion",
  "When companion hooks are not installed, return the receipt and stop; use control tools only if the user insists."
].join("\n\n");

interface FixtureTool {
  name: string;
  inputSchema: Record<string, unknown>;
}

const string = { type: "string", minLength: 1 };
const notify = {
  anyOf: [
    {
      type: "object",
      properties: { type: { type: "string", const: "codex" }, threadId: string },
      required: ["type"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: { type: { type: "string", const: "webhook" }, url: string, secretEnv: string },
      required: ["type", "url", "secretEnv"],
      additionalProperties: false
    }
  ]
};
const commonProperties = {
  cwd: string,
  model: string,
  timeoutMs: { type: "integer", exclusiveMinimum: 0, default: 1_800_000 },
  idleTimeoutMs: { type: "integer", minimum: 0, default: 1_800_000 },
  notify
};

function workSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: { ...commonProperties, ...properties },
    required,
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#"
  };
}

const WORK_SCHEMAS: Record<string, Record<string, unknown>> = {
  mimo_plan: workSchema({ task: string }, ["cwd", "task"]),
  mimo_implement: workSchema({ task: string, allowWrite: { type: "boolean" } }, ["cwd", "task", "allowWrite"]),
  mimo_review: workSchema({ base: { ...string, default: "HEAD" } }, ["cwd"]),
  mimo_fix_ci: workSchema({ file: string, task: string }, ["cwd", "file"]),
  mimo_resume: workSchema({ jobId: string, task: string }, ["cwd", "jobId", "task"]),
  mimo_compose: workSchema({
    workflow: {
      type: "string",
      enum: ["brainstorm", "dev", "fix", "fix-ci", "plan", "execute-plan", "review", "parallel", "worktree", "merge", "new-skill"]
    },
    task: string,
    file: string,
    since: string,
    verification: { type: "array", items: string },
    reportDir: string
  }, ["cwd", "workflow"])
};

function createPluginFixture(
  skillFrontmatter: string,
  options: {
    toolNames?: readonly string[];
    oldWorkField?: string;
    skillBody?: string;
    mutateTools?: (tools: FixtureTool[]) => void;
    mutateMcp?: (mcp: {
      mcpServers: Record<string, Record<string, unknown>>;
    }) => void;
  } = {}
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

  const mcp = {
    mcpServers: {
      "codex-mimocode": {
        type: "stdio",
        command: "node",
        args: ["dist/codex/mcp-server.js"],
        cwd: ".",
        env: {} as Record<string, string>,
        env_vars: ["CODEX_THREAD_ID"] as string[] | undefined
      }
    }
  };
  options.mutateMcp?.(mcp);
  writeFileSync(path.join(root, ".mcp.json"), JSON.stringify(mcp, null, 2));

  writeFileSync(
    path.join(root, "skills", "mimocode", "SKILL.md"),
    `${skillFrontmatter}\n\n# MiMoCode\n\n${options.skillBody ?? VALID_MIMOCODE_SKILL_BODY}\n`
  );
  const tools: FixtureTool[] = (options.toolNames ?? EXPECTED_TOOLS).map((name) => ({
    name,
    inputSchema: structuredClone(WORK_SCHEMAS[name] ?? { type: "object", properties: {} })
  }));
  if (options.oldWorkField) {
    const plan = tools.find((tool) => tool.name === "mimo_plan")!;
    (plan.inputSchema.properties as Record<string, unknown>)[options.oldWorkField] = { type: "boolean" };
  }
  options.mutateTools?.(tools);
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
    expect(result.stderr).toContain("mimo_plan input schema must match the canonical contract");
  });

  it("rejects an extra legacy work-tool property", () => {
    const root = createPluginFixture("---\nname: mimocode\ndescription: Use MiMoCode.\n---", {
      mutateTools: (tools) => {
        const plan = tools.find((tool) => tool.name === "mimo_plan")!;
        (plan.inputSchema.properties as Record<string, unknown>).session = { type: "string" };
      }
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("mimo_plan input schema must match the canonical contract");
  });

  it("rejects a missing required work-tool field", () => {
    const root = createPluginFixture("---\nname: mimocode\ndescription: Use MiMoCode.\n---", {
      mutateTools: (tools) => {
        const implement = tools.find((tool) => tool.name === "mimo_implement")!;
        implement.inputSchema.required = ["cwd", "task"];
      }
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("mimo_implement input schema must match the canonical contract");
  });

  it("rejects a work-tool schema that permits unknown properties", () => {
    const root = createPluginFixture("---\nname: mimocode\ndescription: Use MiMoCode.\n---", {
      mutateTools: (tools) => {
        tools.find((tool) => tool.name === "mimo_review")!.inputSchema.additionalProperties = true;
      }
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("mimo_review input schema must match the canonical contract");
  });

  it("rejects an unknown nested notify property", () => {
    const root = createPluginFixture("---\nname: mimocode\ndescription: Use MiMoCode.\n---", {
      mutateTools: (tools) => {
        const compose = tools.find((tool) => tool.name === "mimo_compose")!;
        const notifySchema = (compose.inputSchema.properties as Record<string, any>).notify;
        notifySchema.anyOf[0].properties.session = { type: "string" };
      }
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("mimo_compose input schema must match the canonical contract");
  });

  it("rejects skill guidance that tells Codex to loop on mimo_wait", () => {
    const root = createPluginFixture("---\nname: mimocode\ndescription: Use MiMoCode.\n---", {
      skillBody: `${VALID_MIMOCODE_SKILL_BODY}\n\nLoop and call mimo_wait frequently until the work finishes.`
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not instruct Codex to poll or loop on mimo_wait");
  });

  it("rejects packaged MCP config that omits CODEX_THREAD_ID env_vars forwarding", () => {
    const root = createPluginFixture("---\nname: mimocode\ndescription: Use MiMoCode.\n---", {
      mutateMcp: (mcp) => {
        delete mcp.mcpServers["codex-mimocode"].env_vars;
      }
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must forward CODEX_THREAD_ID");
  });

  it("rejects packaged MCP config that sets CODEX_THREAD_ID statically", () => {
    const root = createPluginFixture("---\nname: mimocode\ndescription: Use MiMoCode.\n---", {
      mutateMcp: (mcp) => {
        mcp.mcpServers["codex-mimocode"].env = { CODEX_THREAD_ID: "stale-thread" };
      }
    });

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not set CODEX_THREAD_ID statically");
  });
});
