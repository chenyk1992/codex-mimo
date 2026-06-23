import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  mimoCompose,
  mimoFixCi,
  mimoHealthcheck,
  mimoImplement,
  mimoPlan,
  mimoResume,
  mimoReview,
  mimoStatus,
  mimoResult,
  mimoCancel,
  mimoJobs,
  mimoResumeJob
} from "./tools.js";
import { ComposeWorkflowSchema } from "./tool-schemas.js";

export const MIMO_TOOL_NAMES = [
  "mimo_healthcheck",
  "mimo_plan",
  "mimo_implement",
  "mimo_review",
  "mimo_fix_ci",
  "mimo_resume",
  "mimo_compose",
  "mimo_status",
  "mimo_result",
  "mimo_cancel",
  "mimo_jobs",
  "mimo_resume_job"
] as const;

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

  server.tool(
    "mimo_compose",
    "Run a MiMoCode Compose workflow and return a structured report",
    {
      cwd: z.string().describe("Project root directory"),
      workflow: ComposeWorkflowSchema,
      task: z.string().optional().describe("Task description"),
      file: z.string().optional().describe("Attached file such as CI log or plan document"),
      since: z.string().optional().describe("Git ref for diff comparison"),
      model: z.string().optional().describe("Model override"),
      attach: z.string().optional().describe("Running MiMoCode server URL"),
      session: z.string().optional().describe("MiMoCode session ID"),
      fork: z.boolean().default(false),
      continue: z.boolean().default(false).describe("Continue previous session"),
      verification: z.array(z.string()).optional().describe("Verification commands"),
      dryRun: z.boolean().default(false),
      reportDir: z.string().optional().describe("Report directory"),
      timeoutMs: z.number().int().positive().default(1_800_000).describe("MiMoCode process timeout in milliseconds (default: 30 minutes)"),
      background: z.boolean().default(false).describe("Run as background job"),
      wait: z.boolean().default(false).describe("Wait for background job to complete")
    },
    async (args, extra) => {
      const result = await mimoCompose(args, {}, { signal: extra.signal });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "mimo_status",
    "Show active or recent MiMoCode job status.",
    {
      cwd: z.string().describe("Project root directory"),
      jobId: z.string().optional().describe("Job ID (defaults to most recent)")
    },
    async (args) => {
      const result = await mimoStatus(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "mimo_result",
    "Return the compact final result for a finished MiMoCode job.",
    {
      cwd: z.string().describe("Project root directory"),
      jobId: z.string().optional().describe("Job ID (defaults to most recent finished)")
    },
    async (args) => {
      const result = await mimoResult(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "mimo_cancel",
    "Cancel an active MiMoCode background job.",
    {
      cwd: z.string().describe("Project root directory"),
      jobId: z.string().describe("Job ID to cancel")
    },
    async (args) => {
      const result = await mimoCancel(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "mimo_jobs",
    "List recent MiMoCode jobs for a workspace.",
    {
      cwd: z.string().describe("Project root directory"),
      all: z.boolean().default(false).describe("List all jobs instead of recent")
    },
    async (args) => {
      const result = await mimoJobs(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "mimo_resume_job",
    "Create a follow-up job from a previous job's MiMoCode session.",
    {
      cwd: z.string().describe("Project root directory"),
      jobId: z.string().describe("Parent job ID to resume from"),
      task: z.string().describe("Task for the resumed job"),
      background: z.boolean().default(false).describe("Run as background job")
    },
    async (args) => {
      const result = await mimoResumeJob(args);
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
