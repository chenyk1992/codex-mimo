import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeInput, FixCiInput, ImplementInput, PlanInput, ReviewInput } from "../../src/codex/tool-schemas.js";

const mocks = vi.hoisted(() => ({ tool: vi.fn(), connect: vi.fn() }));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    tool = mocks.tool;
    connect = mocks.connect;
  }
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {}
}));

describe("MCP work schema registration", () => {
  beforeEach(() => {
    mocks.tool.mockClear();
    mocks.connect.mockResolvedValue(undefined);
  });

  it("registers each work tool from the same Zod schema shape used by its handler", async () => {
    const { createMcpServer } = await import("../../src/codex/mcp-server.js");
    createMcpServer();
    const expected = new Map<string, unknown>([
      ["mimo_plan", PlanInput.shape],
      ["mimo_implement", ImplementInput.shape],
      ["mimo_review", ReviewInput.shape],
      ["mimo_fix_ci", FixCiInput.shape],
      ["mimo_compose", ComposeInput.shape]
    ]);
    for (const [name, shape] of expected) {
      const call = mocks.tool.mock.calls.find((candidate) => candidate[0] === name);
      expect(call?.[2], name).toStrictEqual(shape);
    }
  });
});
