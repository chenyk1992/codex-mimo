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

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "codex-mimocode", version: "0.1.0" });

  server.tool("mimo_healthcheck", "Check MiMoCode installation and auth state", HealthcheckInput.shape,
    async (args) => textResult(await mimoHealthcheck(args)));
  server.tool("mimo_plan", "Create an implementation plan in a background job", PlanInput.shape,
    async (args) => textResult(await mimoPlan(args)));
  server.tool("mimo_implement", "Implement code changes in a background job", ImplementInput.shape,
    async (args) => textResult(await mimoImplement(args)));
  server.tool("mimo_review", "Review the current diff in a background job", ReviewInput.shape,
    async (args) => textResult(await mimoReview(args)));
  server.tool("mimo_fix_ci", "Fix CI failures in a background job", FixCiInput.shape,
    async (args) => textResult(await mimoFixCi(args)));
  server.tool("mimo_resume", "Resume a paused job through its parent job ID", ResumeInput.shape,
    async (args) => textResult(await mimoResume(args)));
  server.tool("mimo_compose", "Run a Compose workflow in a background job", ComposeInput.shape,
    async (args) => textResult(await mimoCompose(args)));
  server.tool("mimo_status", "Show compact status for an active or recent job", JobStatusInput.shape,
    async (args) => textResult(await mimoStatus(args)));
  server.tool("mimo_events", "Return incremental compact job signals", JobEventsInput.shape,
    async (args) => textResult(await mimoEvents(args)));
  server.tool("mimo_wait", "Wait for a job event that requires caller attention", JobWaitInput.shape,
    async (args) => textResult(await mimoWait(args)));
  server.tool("mimo_result", "Return a compact partial or final job result", JobResultInput.shape,
    async (args) => textResult(await mimoResult(args)));
  server.tool("mimo_cancel", "Cancel a queued or running job", JobCancelInput.shape,
    async (args) => textResult(await mimoCancel(args)));
  server.tool("mimo_jobs", "List recent compact job statuses", JobListInput.shape,
    async (args) => textResult(await mimoJobs(args)));

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
