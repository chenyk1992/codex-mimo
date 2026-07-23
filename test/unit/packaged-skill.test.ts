import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("packaged MiMoCode skill", () => {
  const skill = fs.readFileSync("skills/mimocode/SKILL.md", "utf8");

  it("teaches Desktop native heartbeat as the primary wait path", () => {
    expect(skill).toContain("Expected MCP Tools (13)");
    expect(skill).toMatch(/call one work tool/i);
    expect(skill).toMatch(/return the queued receipt/i);
    expect(skill).toMatch(/Codex Desktop/i);
    expect(skill).toMatch(/heartbeat|scheduled follow-up|in-chat scheduled/i);
    expect(skill).toMatch(/omit(?:s|ting)? `?notify`?|without `?notify`?|do not (?:pass|send) `?notify`?/i);
    expect(skill).toMatch(/mimo_status/);
    expect(skill).toMatch(/mimo_result/);
    expect(skill).toMatch(/(?:delete|cancel|remove|stop)[\s\S]{0,80}(?:heartbeat|schedule|follow-up)/i);
  });

  it("demotes App Server notify to compatibility history writeback", () => {
    expect(skill).toMatch(/compat|compatibility|CLI/i);
    expect(skill).toMatch(/history write|session (?:history|storage)|not[\s\S]{0,80}Desktop[\s\S]{0,80}(?:visible|visibility|refresh|UI)/i);
    expect(skill).toMatch(/delivered[\s\S]{0,160}(?:not|does not|never)[\s\S]{0,120}(?:Desktop|renderer|UI|visible)/i);
  });

  it("covers attention outcomes and heartbeat cleanup", () => {
    expect(skill).toMatch(/needs_input/);
    expect(skill).toMatch(/blocked|cancelled|timeout|failed/i);
    expect(skill).toMatch(/(?:delete|cancel|remove|stop)[\s\S]{0,100}(?:heartbeat|schedule|follow-up)/i);
  });

  it("contains none of the removed orchestration guidance", () => {
    expect(skill).not.toMatch(/mimo_wake|mimo_resume_job|background\s*:\s*true/i);
    expect(skill).not.toMatch(/(?:loop|poll|frequent(?:ly)?|repeat(?:ed|edly)?)[^\n.]{0,100}mimo_wait/i);
    expect(skill).not.toMatch(/Every Codex Desktop work launch must send `notify/i);
  });
});
