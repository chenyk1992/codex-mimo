import { describe, expect, it } from "vitest";
import { inferPhaseFromEvent, summarizeEventForLog } from "../../src/core/job-phase.js";
import type { NormalizedMimoEvent } from "../../src/compose/events.js";

function event(input: Partial<NormalizedMimoEvent>): NormalizedMimoEvent {
  return { type: "raw", raw: input, ...input } as NormalizedMimoEvent;
}

describe("job phase inference", () => {
  it("maps tool events to editing, verifying, and investigating", () => {
    expect(inferPhaseFromEvent(event({ type: "tool", toolName: "edit", status: "completed" }))).toBe("editing");
    expect(inferPhaseFromEvent(event({ type: "tool", toolName: "bash", status: "running", text: "npm test" }))).toBe("verifying");
    expect(inferPhaseFromEvent(event({ type: "tool", toolName: "bash", status: "running", text: "ls" }))).toBe("investigating");
  });

  it("maps message and error events", () => {
    expect(inferPhaseFromEvent(event({ type: "message", text: "looking at the failure" }))).toBe("investigating");
    expect(inferPhaseFromEvent(event({ type: "error", text: "boom" }))).toBe("failed");
  });

  it("summarizes events for logs", () => {
    expect(summarizeEventForLog(event({ type: "message", text: "done" }))).toBe("done");
    expect(summarizeEventForLog(event({ type: "tool", toolName: "bash", status: "completed" }))).toBe("Tool bash completed.");
    expect(summarizeEventForLog(event({ type: "raw", text: "raw text" }))).toBe("raw text");
  });

  it("5.29: maps write tool to editing", () => {
    expect(inferPhaseFromEvent(event({ type: "tool", toolName: "write", status: "completed" }))).toBe("editing");
  });

  it("5.30: maps apply_patch tool to editing", () => {
    expect(inferPhaseFromEvent(event({ type: "tool", toolName: "apply_patch", status: "completed" }))).toBe("editing");
  });

  it("5.31: maps bash with lint command to verifying", () => {
    expect(inferPhaseFromEvent(event({ type: "tool", toolName: "bash", status: "running", text: "npm run lint" }))).toBe("verifying");
  });

  it("5.32: maps bash with typecheck command to verifying", () => {
    expect(inferPhaseFromEvent(event({ type: "tool", toolName: "bash", status: "running", text: "npm run typecheck" }))).toBe("verifying");
  });

  it("5.33: maps diff event to editing", () => {
    expect(inferPhaseFromEvent(event({ type: "diff", path: "src/index.ts" }))).toBe("editing");
  });
});
