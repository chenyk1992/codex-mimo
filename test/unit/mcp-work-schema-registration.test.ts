import { beforeEach, describe, expect, it, vi } from "vitest";
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
} from "../../src/codex/tool-schemas.js";
import { MIMO_TOOL_NAMES } from "../../src/codex/tool-names.js";

const mocks = vi.hoisted(() => ({ registerTool: vi.fn(), connect: vi.fn() }));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool = mocks.registerTool;
    connect = mocks.connect;
  }
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {}
}));

describe("MCP work schema registration", () => {
  beforeEach(() => {
    mocks.registerTool.mockClear();
    mocks.connect.mockResolvedValue(undefined);
  });

  it("registers each work tool from the same Zod schema shape used by its handler", async () => {
    const { createMcpServer } = await import("../../src/codex/mcp-server.js");
    mocks.registerTool.mockClear();
    createMcpServer();
    const expected = new Map<string, unknown>([
      ["mimo_plan", PlanInput],
      ["mimo_implement", ImplementInput],
      ["mimo_review", ReviewInput],
      ["mimo_fix_ci", FixCiInput],
      ["mimo_resume", ResumeInput],
      ["mimo_compose", ComposeInput],
      ["mimo_healthcheck", HealthcheckInput],
      ["mimo_status", JobStatusInput],
      ["mimo_events", JobEventsInput],
      ["mimo_wait", JobWaitInput],
      ["mimo_result", JobResultInput],
      ["mimo_cancel", JobCancelInput],
      ["mimo_jobs", JobListInput]
    ]);
    for (const [name, schema] of expected) {
      const call = mocks.registerTool.mock.calls.find((candidate) => candidate[0] === name);
      expect(call?.[1]?.inputSchema, name).toBe(schema);
    }
    expect(mocks.registerTool.mock.calls.map((call) => call[0])).toEqual([...MIMO_TOOL_NAMES]);
  });

  it("describes mimo_compose plan read-only contract and job-result delivery", async () => {
    const { createMcpServer } = await import("../../src/codex/mcp-server.js");
    mocks.registerTool.mockClear();
    createMcpServer();
    const compose = mocks.registerTool.mock.calls.find((call) => call[0] === "mimo_compose");
    const description = compose?.[1]?.description ?? "";
    expect(description.toLowerCase()).toMatch(/plan/);
    expect(description.toLowerCase()).toMatch(/read-only|read only/);
    expect(description.toLowerCase()).toMatch(/summary/);
    expect(description.toLowerCase()).toMatch(/saved plan path/);
    const result = mocks.registerTool.mock.calls.find((call) => call[0] === "mimo_result");
    const resultDescription = result?.[1]?.description ?? "";
    expect(resultDescription.toLowerCase()).toMatch(/compact/);
    expect(resultDescription.toLowerCase()).toMatch(/full/);
  });
});
