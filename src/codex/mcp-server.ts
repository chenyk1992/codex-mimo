import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  mimoCancel,
  mimoCompose,
  mimoEvents,
  mimoFixCi,
  mimoHealthcheck,
  mimoImplement,
  mimoJobs,
  mimoPlan,
  mimoResult,
  mimoResume,
  mimoReview,
  mimoStatus,
  mimoWait
} from "./tools.js";
import {
  ComposeInput,
  FixCiInput,
  HealthcheckInput,
  ImplementInputBase,
  JobCancelInput,
  JobEventsInput,
  JobListInput,
  JobResultInput,
  JobStatusInput,
  JobWaitInput,
  PlanInput,
  ResumeInput,
  ReviewInput
} from "./tool-schemas.js";
import { appendMcpToolAudit } from "./tool-audit.js";

function textResult(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

export type McpToolHandler = (input: unknown) => Promise<unknown>;

export interface McpToolHandlers {
  mimoHealthcheck: McpToolHandler;
  mimoPlan: McpToolHandler;
  mimoImplement: McpToolHandler;
  mimoReview: McpToolHandler;
  mimoFixCi: McpToolHandler;
  mimoResume: McpToolHandler;
  mimoCompose: McpToolHandler;
  mimoStatus: McpToolHandler;
  mimoEvents: McpToolHandler;
  mimoWait: McpToolHandler;
  mimoResult: McpToolHandler;
  mimoCancel: McpToolHandler;
  mimoJobs: McpToolHandler;
}

const DEFAULT_HANDLERS: McpToolHandlers = {
  mimoHealthcheck,
  mimoPlan,
  mimoImplement,
  mimoReview,
  mimoFixCi,
  mimoResume,
  mimoCompose,
  mimoStatus,
  mimoEvents,
  mimoWait,
  mimoResult,
  mimoCancel,
  mimoJobs
};

export function createMcpServer(overrides: Partial<McpToolHandlers> = {}): McpServer {
  const server = new McpServer({ name: "codex-mimocode", version: "0.1.0" });
  const handlers = { ...DEFAULT_HANDLERS, ...overrides };
  const handle = (toolName: string, handler: McpToolHandler) => async (args: unknown) => {
    appendMcpToolAudit(toolName);
    return textResult(await handler(args));
  };

  server.registerTool("mimo_healthcheck", {
    description: "Check MiMoCode installation and auth state", inputSchema: HealthcheckInput
  }, handle("mimo_healthcheck", handlers.mimoHealthcheck));
  server.registerTool("mimo_plan", {
    description: "Create an implementation plan in a background job", inputSchema: PlanInput
  }, handle("mimo_plan", handlers.mimoPlan));
  server.registerTool("mimo_implement", {
    description: "Implement code changes in a background job with ordered acceptance and optional batching",
    inputSchema: ImplementInputBase
  }, handle("mimo_implement", handlers.mimoImplement));
  server.registerTool("mimo_review", {
    description: "Review the current diff in a background job", inputSchema: ReviewInput
  }, handle("mimo_review", handlers.mimoReview));
  server.registerTool("mimo_fix_ci", {
    description: "Fix CI failures with optional allowedPaths; host acceptance is required before verified success",
    inputSchema: FixCiInput
  }, handle("mimo_fix_ci", handlers.mimoFixCi));
  server.registerTool("mimo_resume", {
    description: "Resume a paused job; acceptance and allowedPaths may override inherited values",
    inputSchema: ResumeInput
  }, handle("mimo_resume", handlers.mimoResume));
  server.registerTool("mimo_compose", {
    description: "Run a Compose workflow in a background job; plan workflows are read-only with compact results",
    inputSchema: ComposeInput
  }, handle("mimo_compose", handlers.mimoCompose));
  server.registerTool("mimo_status", {
    description: "Return compact execution status and deliverable assessment by default",
    inputSchema: JobStatusInput
  }, handle("mimo_status", handlers.mimoStatus));
  server.registerTool("mimo_events", {
    description: "Return incremental compact job signals", inputSchema: JobEventsInput
  }, handle("mimo_events", handlers.mimoEvents));
  server.registerTool("mimo_wait", {
    description: "Wait for a job event that requires caller attention", inputSchema: JobWaitInput
  }, handle("mimo_wait", handlers.mimoWait));
  server.registerTool("mimo_result", {
    description: "Return compact result by default; request standard or full for diagnostics",
    inputSchema: JobResultInput
  }, handle("mimo_result", handlers.mimoResult));
  server.registerTool("mimo_cancel", {
    description: "Cancel a queued or running job", inputSchema: JobCancelInput
  }, handle("mimo_cancel", handlers.mimoCancel));
  server.registerTool("mimo_jobs", {
    description: "List recent compact job statuses", inputSchema: JobListInput
  }, handle("mimo_jobs", handlers.mimoJobs));

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

startMcpServer().catch((error) => {
  console.error("MCP server failed to start:", error);
  process.exit(1);
});
