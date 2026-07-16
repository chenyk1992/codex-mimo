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
  mimoEvents,
  mimoWait,
  mimoWake,
  mimoResult,
  mimoCancel,
  mimoJobs,
  mimoResumeJob
} from "./tools.js";
import {
  ComposeInput,
  FixCiInput,
  ImplementInput,
  PlanInput,
  ReviewInput
} from "./tool-schemas.js";
export { MIMO_TOOL_NAMES } from "./tool-names.js";

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
    PlanInput.shape,
    async (args) => {
      const result = await mimoPlan(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "mimo_implement",
    "Implement code changes using MiMoCode implementation agent",
    ImplementInput.shape,
    async (args) => {
      const result = await mimoImplement(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "mimo_review",
    "Review the current diff using MiMoCode review agent",
    ReviewInput.shape,
    async (args) => {
      const result = await mimoReview(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "mimo_fix_ci",
    "Fix CI failures using MiMoCode with a CI log file",
    FixCiInput.shape,
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
      task: z.string().describe("Task to continue"),
      timeoutMs: z.number().int().positive().default(1_800_000).describe("MiMoCode process timeout in milliseconds")
    },
    async (args) => {
      const result = await mimoResume(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "mimo_compose",
    "Run a MiMoCode Compose workflow and return a structured report",
    ComposeInput.shape,
    async (args) => {
      const result = await mimoCompose(args);
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
    "mimo_events",
    "Return incremental high-signal events for a MiMoCode job.",
    {
      cwd: z.string().describe("Project root directory"),
      jobId: z.string().optional().describe("Job ID (defaults to most recent)"),
      sinceCursor: z.number().int().nonnegative().default(0).describe("Only return signals after this cursor"),
      limit: z.number().int().positive().max(100).default(20).describe("Maximum number of signals to return"),
      minLevel: z.enum(["debug", "info", "warn", "error"]).default("debug").describe("Minimum signal level")
    },
    async (args) => {
      const result = await mimoEvents(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "mimo_wait",
    "Wait for new high-signal events from a MiMoCode job without Codex-side polling.",
    {
      cwd: z.string().describe("Project root directory"),
      jobId: z.string().optional().describe("Job ID (defaults to most recent)"),
      sinceCursor: z.number().int().nonnegative().default(0).describe("Only return signals after this cursor"),
      limit: z.number().int().positive().max(100).default(20).describe("Maximum number of signals to return"),
      minLevel: z.enum(["debug", "info", "warn", "error"]).default("debug").describe("Minimum signal level"),
      timeoutMs: z.number().int().positive().default(1_800_000).describe("Maximum time to wait for new signals"),
      pollMs: z.number().int().positive().max(60_000).default(1_000).describe("Internal signal check interval")
    },
    async (args) => {
      const result = await mimoWait(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "mimo_wake",
    "Build a Codex heartbeat wake prompt for a MiMoCode background job.",
    {
      cwd: z.string().describe("Project root directory"),
      jobId: z.string().optional().describe("Job ID (defaults to most recent)"),
      sinceCursor: z.number().int().nonnegative().default(0).describe("Only return signals after this cursor"),
      minLevel: z.enum(["debug", "info", "warn", "error"]).default("debug").describe("Minimum signal level"),
      timeoutMs: z.number().int().positive().default(1_800_000).describe("Maximum time each heartbeat should wait for new signals")
    },
    async (args) => {
      const result = await mimoWake(args);
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
