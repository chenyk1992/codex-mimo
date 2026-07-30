import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("packaged MiMoCode skill", () => {
  const entry = fs.readFileSync("skills/mimocode/SKILL.md", "utf8");
  const references = [
    "desktop-delivery.md",
    "cursor-delivery.md",
    "app-server-notify.md",
    "recovery-and-errors.md",
    "compose-workflows.md",
    "diagnostics.md"
  ];
  const skill = [
    entry,
    ...references.map((file) => fs.readFileSync(`skills/mimocode/references/${file}`, "utf8"))
  ].join("\n\n");

  it("keeps the always-loaded entry compact and routes optional detail", () => {
    expect(Buffer.byteLength(entry, "utf8")).toBeLessThanOrEqual(8_192);
    for (const reference of references) {
      expect(entry).toContain(`references/${reference}`);
    }
    expect(entry).toMatch(/complete work-tool call/i);
    expect(entry).toMatch(/compact `mimo_status`/i);
    expect(entry).toMatch(/narrowest meaningful independent check/i);
  });

  it("teaches Desktop native heartbeat as the primary wait path", () => {
    expect(skill).toContain("Expected MCP Tools (13)");
    expect(skill).toMatch(/call one work tool/i);
    expect(skill).toMatch(/return the queued receipt/i);
    expect(skill).toMatch(/Codex Desktop/i);
    expect(skill).toMatch(/heartbeat|scheduled follow-up|in-chat scheduled/i);
    expect(skill).toMatch(/every 5 minutes|5-minute/i);
    expect(skill).not.toMatch(/about once per minute/i);
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
    expect(skill).toMatch(/stalled/);
    expect(skill).toMatch(/blocked|cancelled|timeout|failed/i);
    expect(skill).toMatch(/(?:delete|cancel|remove|stop)[\s\S]{0,100}(?:heartbeat|schedule|follow-up)/i);
    expect(skill).toMatch(/mimo_result[\s\S]{0,160}(?:stalled|needs_input|blocked|timeout)/i);
  });

  it("teaches compact result consumption and explicit full diagnostics", () => {
    expect(skill).toMatch(/mimo_status[\s\S]{0,100}compact/i);
    expect(skill).toMatch(/mimo_result[\s\S]{0,120}compact/i);
    expect(skill).toMatch(/reportPath|report path|saved plan/i);
    expect(skill).toMatch(/(?:level|output level)[\s\S]{0,100}full/i);
    expect(skill).not.toMatch(/answer from `?mimo_result\.output`? when present/i);
  });

  it("contains none of the removed orchestration guidance", () => {
    expect(skill).not.toMatch(/mimo_wake|mimo_resume_job|background\s*:\s*true/i);
    expect(skill).not.toMatch(/(?:loop|poll|frequent(?:ly)?|repeat(?:ed|edly)?)[^\n.]{0,100}mimo_wait/i);
    expect(skill).not.toMatch(/Every Codex Desktop work launch must send `notify/i);
  });

  it("teaches ordered development acceptance and resumable acceptance failures", () => {
    expect(skill).toMatch(/acceptance\.build|acceptance:\s*\{[\s\S]{0,80}build/);
    expect(skill).toMatch(/diffCheck/);
    expect(skill).toMatch(/build_failed/);
    expect(skill).toMatch(/tests_failed/);
    expect(skill).toMatch(/diff_check_failed/);
    expect(skill).toMatch(/acceptance_config_missing/);
    expect(skill).toMatch(/delivery_contract_missing/);
    expect(skill).toMatch(/verification[\s\S]{0,120}(?:test stage|maps to(?: the)? test)/i);
    expect(skill).toMatch(/(?:`dev`|dev)[\s\S]{0,200}(?:`execute-plan`|execute-plan)[\s\S]{0,200}(?:`implement`|implement)|(?:`implement`|implement)[\s\S]{0,200}(?:`dev`|dev)/i);
    expect(skill).toMatch(/(?:cannot|must not|never)[\s\S]{0,80}complet[\s\S]{0,120}acceptance|without acceptance[\s\S]{0,80}complet/i);
    expect(skill).toMatch(
      /mimo_resume[\s\S]{0,280}(?:build_failed|tests_failed|diff_check_failed|delivery_contract_missing)/i
    );
  });

  it("teaches batchMode slice chains and root-only notifications", () => {
    expect(skill).toMatch(/batchMode/);
    expect(skill).toMatch(/auto/);
    expect(skill).toMatch(/single/);
    expect(skill).toMatch(/sliced/);
    expect(skill).toMatch(/slice_plan_invalid/);
    expect(skill).toMatch(/slice_failed/);
    expect(skill).toMatch(/\.slices\.json/);
    expect(skill).toMatch(/\.chain\.json/);
    expect(skill).toMatch(/one slice at a time/i);
    expect(skill).toMatch(/only the root job notifies|children omit notification/i);
    expect(skill).toMatch(/skips completed slices|never relaunches completed/i);
  });
});
