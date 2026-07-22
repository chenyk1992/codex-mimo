import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("packaged MiMoCode skill", () => {
  const skill = fs.readFileSync("skills/mimocode/SKILL.md", "utf8");

  it("teaches the callback-driven no-poll workflow", () => {
    expect(skill).toContain("Expected MCP Tools (13)");
    expect(skill).toMatch(/call one work tool/i);
    expect(skill).toMatch(/return the queued receipt/i);
    expect(skill).toMatch(/do not call `mimo_status`, `mimo_events`, or `mimo_wait`/i);
    expect(skill).toMatch(/callback turn/i);
    expect(skill).toMatch(/when resumed[\s\S]{0,120}`mimo_result`/i);
    expect(skill).toMatch(/explicit user diagnostics/i);
  });

  it("contains none of the removed orchestration guidance", () => {
    expect(skill).not.toMatch(/mimo_wake|mimo_resume_job|background\s*:\s*true|heartbeat/i);
    expect(skill).not.toMatch(/(?:loop|poll|frequent(?:ly)?|repeat(?:ed|edly)?)[^\n.]{0,100}mimo_wait/i);
  });
});
