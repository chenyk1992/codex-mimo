import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  mimoFixCi,
  mimoHealthcheck,
  mimoImplement,
  mimoPlan,
  mimoResume,
  mimoReview
} from "./tools.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "codex-mimocode",
    version: "0.1.0"
  });

  server.tool(
    "mimo_healthcheck",
    "Check MiMoCode installation and auth state",
    {
      cwd: z.string().optional().describe("Project root directory")
    },
    async (args) => {
      const result = await mimoHealthcheck(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "mimo_plan",
    "Create an implementation plan using MiMoCode planning agent",
    {
      cwd: z.string().describe("Project root directory"),
      task: z.string().describe("Task description"),
      agent: z.string().default("plan").describe("MiMoCode agent name"),
      model: z.string().optional().describe("Model override")
    },
    async (args) => {
      const result = await mimoPlan(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "mimo_implement",
    "Implement code changes using MiMoCode implementation agent",
    {
      cwd: z.string().describe("Project root directory"),
      task: z.string().describe("Task description"),
      allowWrite: z.boolean().default(false).describe("Allow MiMoCode to write files"),
      allowInstall: z.boolean().default(false).describe("Allow package install")
    },
    async (args) => {
      const result = await mimoImplement(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "mimo_review",
    "Review the current diff using MiMoCode review agent",
    {
      cwd: z.string().describe("Project root directory"),
      base: z.string().default("HEAD").describe("Git base ref to diff against")
    },
    async (args) => {
      const result = await mimoReview(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "mimo_fix_ci",
    "Fix CI failures using MiMoCode with a CI log file",
    {
      cwd: z.string().describe("Project root directory"),
      file: z.string().describe("Path to CI log file"),
      task: z.string().optional().describe("Additional task context")
    },
    async (args) => {
      const result = await mimoFixCi(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "mimo_resume",
    "Resume a previous MiMoCode session",
    {
      cwd: z.string().describe("Project root directory"),
      session: z.string().describe("MiMoCode session ID"),
      task: z.string().describe("Task to continue")
    },
    async (args) => {
      const result = await mimoResume(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

startMcpServer().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
