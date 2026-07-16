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
  ImplementInput,
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
export { MIMO_TOOL_NAMES } from "./tool-names.js";

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

  server.registerTool("mimo_healthcheck", {
    description: "Check MiMoCode installation and auth state", inputSchema: HealthcheckInput
  }, async (args) => textResult(await handlers.mimoHealthcheck(args)));
  server.registerTool("mimo_plan", {
    description: "Create an implementation plan in a background job", inputSchema: PlanInput
  }, async (args) => textResult(await handlers.mimoPlan(args)));
  server.registerTool("mimo_implement", {
    description: "Implement code changes in a background job", inputSchema: ImplementInput
  }, async (args) => textResult(await handlers.mimoImplement(args)));
  server.registerTool("mimo_review", {
    description: "Review the current diff in a background job", inputSchema: ReviewInput
  }, async (args) => textResult(await handlers.mimoReview(args)));
  server.registerTool("mimo_fix_ci", {
    description: "Fix CI failures in a background job", inputSchema: FixCiInput
  }, async (args) => textResult(await handlers.mimoFixCi(args)));
  server.registerTool("mimo_resume", {
    description: "Resume a paused job through its parent job ID", inputSchema: ResumeInput
  }, async (args) => textResult(await handlers.mimoResume(args)));
  server.registerTool("mimo_compose", {
    description: "Run a Compose workflow in a background job", inputSchema: ComposeInput
  }, async (args) => textResult(await handlers.mimoCompose(args)));
  server.registerTool("mimo_status", {
    description: "Show compact status for an active or recent job", inputSchema: JobStatusInput
  }, async (args) => textResult(await handlers.mimoStatus(args)));
  server.registerTool("mimo_events", {
    description: "Return incremental compact job signals", inputSchema: JobEventsInput
  }, async (args) => textResult(await handlers.mimoEvents(args)));
  server.registerTool("mimo_wait", {
    description: "Wait for a job event that requires caller attention", inputSchema: JobWaitInput
  }, async (args) => textResult(await handlers.mimoWait(args)));
  server.registerTool("mimo_result", {
    description: "Return a compact partial or final job result", inputSchema: JobResultInput
  }, async (args) => textResult(await handlers.mimoResult(args)));
  server.registerTool("mimo_cancel", {
    description: "Cancel a queued or running job", inputSchema: JobCancelInput
  }, async (args) => textResult(await handlers.mimoCancel(args)));
  server.registerTool("mimo_jobs", {
    description: "List recent compact job statuses", inputSchema: JobListInput
  }, async (args) => textResult(await handlers.mimoJobs(args)));

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
