import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SKILL = "skills/mimocode/SKILL.md";
const USER_DOCS = ["README.md", "doc/operations-guide.md", "doc/compose-workflows.md"] as const;
const ALL_DOCS = [SKILL, ...USER_DOCS] as const;

function readDoc(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

describe("public release contract", () => {
  it("describes the six queued work tools and seven control or diagnostic tools", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(".codex-plugin/plugin.json"), "utf8")
    ) as { interface?: { longDescription?: string }; keywords?: string[] };

    expect(manifest.interface?.longDescription).toMatch(/six queued work tools/i);
    expect(manifest.interface?.longDescription).toMatch(/seven control(?: and|\/)diagnostic tools/i);
    expect(manifest.interface?.longDescription).toMatch(/heartbeat|scheduled follow-up|in-chat/i);
    expect(manifest.keywords ?? []).not.toContain("acp");
  });

  it("documents the complete CLI exit-code contract", () => {
    for (const file of ["README.md", "doc/operations-guide.md"]) {
      const contents = readDoc(file);
      expect(contents).toMatch(/exit codes?[\s\S]{0,160}`?0`?[^\n]*success/i);
      expect(contents).toMatch(/`?2`?[^\n]*(?:command|input|schema)/i);
      expect(contents).toMatch(/`?1`?[^\n]*runtime[^\n]*(?:doctor|healthcheck)/i);
    }
  });

  it("publishes Desktop heartbeat as the primary visibility path", () => {
    for (const file of [SKILL, "README.md", "doc/operations-guide.md"]) {
      const contents = readDoc(file);
      expect(contents).toMatch(/heartbeat|scheduled follow-up|in-chat scheduled/i);
      expect(contents).toMatch(/omit(?:s|ting)? `?notify`?|without `?notify`?|do not (?:pass|send) `?notify`?/i);
      expect(contents).toMatch(/mimo_status/);
      expect(contents).toMatch(/mimo_result/);
      expect(contents).toMatch(/(?:delete|cancel|remove|stop)[\s\S]{0,100}(?:heartbeat|schedule|follow-up)/i);
    }
  });

  it("demotes App Server notify delivered to history writeback, not Desktop UI refresh", () => {
    for (const file of [SKILL, "README.md", "doc/operations-guide.md"]) {
      const contents = readDoc(file);
      expect(contents).toMatch(/delivered[\s\S]{0,200}(?:not|does not|never)[\s\S]{0,120}(?:Desktop|renderer|UI|visible|visibility|refresh)/i);
      expect(contents).toMatch(/compat|compatibility|CLI/i);
      expect(contents).toMatch(/notify:\s*\{\s*type:\s*"codex",\s*threadId:/);
    }

    for (const file of USER_DOCS) {
      const contents = readDoc(file);
      expect(contents).toMatch(/notify:\s*\{\s*type:\s*"codex",\s*threadId:/);
    }

    const skill = readDoc(SKILL);
    expect(skill).not.toMatch(/\{\s*"type"\s*:\s*"codex"\s*\}/);
    expect(skill).not.toMatch(/forwards task-scoped `CODEX_THREAD_ID`/i);
    expect(skill).not.toMatch(/packaged MCP server forwards/i);
    expect(skill).not.toMatch(/Every Codex Desktop work launch must send `notify/i);
  });

  it("documents at-least-once Codex App Server delivery for the compatibility path", () => {
    for (const file of ["README.md", "doc/operations-guide.md"]) {
      const contents = readDoc(file);
      expect(contents).toMatch(/at-least-once/i);
      expect(contents).toMatch(/normal(?: operation|-path)[\s\S]{0,180}(?:one|single)[^\n]*(?:turn\/start|delivery)/i);
    }
  });

  it("documents Codex notification preflight before job creation for explicit notify launches", () => {
    for (const file of [SKILL, "README.md", "doc/operations-guide.md"]) {
      const contents = readDoc(file);
      expect(contents).toMatch(/preflight/i);
      expect(contents).toMatch(/before (?:job creation|creating a job|persist)/i);
    }

    for (const file of ["README.md", "doc/operations-guide.md"]) {
      const contents = readDoc(file);
      for (const code of [
        "codex_cli_not_found",
        "codex_cli_not_executable",
        "codex_app_server_unavailable"
      ]) {
        expect(contents).toMatch(new RegExp(code));
      }
      expect(contents).toMatch(/preflight failed[\s\S]{0,120}mimo_healthcheck/i);
      expect(contents).toMatch(/preflight failed[\s\S]{0,160}CODEX_MIMO_CODEX_BIN/i);
    }
  });

  it("documents mimo_result.output as the explicit final assistant output boundary", () => {
    for (const file of ALL_DOCS) {
      const contents = readDoc(file);
      expect(contents).toMatch(/mimo_result\.output/);
    }

    for (const file of USER_DOCS) {
      const contents = readDoc(file);
      expect(contents).toMatch(/explicit(?:ly)?[\s\S]{0,80}mimo_result/i);
    }
  });

  it("documents structural reports that intentionally omit model output", () => {
    for (const file of USER_DOCS) {
      const contents = readDoc(file);
      expect(contents).toMatch(/structural/i);
      expect(contents).toMatch(/omit(?:s|ted)?[\s\S]{0,80}(?:model output|final (?:text|output|assistant))/i);
    }

    const readme = readDoc("README.md");
    expect(readme).toMatch(/reports\/\*\.md/);
    expect(readme).toMatch(/events\.jsonl[\s\S]{0,120}diagnostic/i);
  });

  it("documents result_missing as a planning run with no readable final result", () => {
    for (const file of ALL_DOCS) {
      const contents = readDoc(file);
      expect(contents).toMatch(/result_missing/);
      expect(contents).toMatch(/plan(?:ning)?[\s\S]{0,120}(?:final result|readable final|no readable)/i);
    }
  });

  it("documents that preflight failure does not auto-relaunch without notifications", () => {
    const skill = readDoc(SKILL);
    expect(skill).toMatch(/preflight failure[\s\S]{0,160}stop/i);
    expect(skill).not.toMatch(/retry by omitting `notify`/i);
    expect(skill).toMatch(/explicit (?:user )?choice[\s\S]{0,120}(?:no-notify|without notifications|Cursor companion|heartbeat)/i);

    for (const file of ["README.md", "doc/operations-guide.md"]) {
      const contents = readDoc(file);
      expect(contents).toMatch(/(?:does not|do not|never)[\s\S]{0,80}(?:automatically|auto)[\s\S]{0,80}(?:relaunch|retry|omit)[\s\S]{0,80}notify/i);
    }
  });

  it("documents WindowsApps Desktop codex.exe and CODEX_MIMO_CODEX_BIN prerequisite", () => {
    for (const file of ["README.md", "doc/operations-guide.md"]) {
      const contents = readDoc(file);
      expect(contents).toMatch(/WindowsApps/i);
      expect(contents).toMatch(/CODEX_MIMO_CODEX_BIN/);
      expect(contents).toMatch(/restart(?: Codex)? Desktop/i);
      expect(contents).toMatch(/mimo_healthcheck[\s\S]{0,80}codexNotification\.ok[\s\S]{0,40}true/i);
    }
  });

  it("documents Desktop heartbeat consumption of mimo_result.output in the skill", () => {
    const skill = readDoc(SKILL);
    expect(skill).toMatch(/mimo_result[\s\S]{0,120}output/i);
    expect(skill).toMatch(/(?:heartbeat|follow-up|scheduled)[\s\S]{0,200}mimo_result/i);
  });

  it("documents resolved Execa spawn failures and protected WindowsApps recovery", () => {
    for (const file of [SKILL, "README.md", "doc/operations-guide.md"]) {
      const contents = readDoc(file);
      expect(contents).toMatch(/codex_cli_not_executable/);
      expect(contents).toMatch(/WindowsApps/i);
      expect(contents).toMatch(/CODEX_MIMO_CODEX_BIN/);
      expect(contents).toMatch(/restart(?: Codex)? Desktop/i);
      expect(contents).toMatch(/mimo_healthcheck/i);
    }
  });

  it("distinguishes preflight launchability from later callback delivery", () => {
    for (const file of ["README.md", "doc/operations-guide.md"]) {
      const contents = readDoc(file);
      expect(contents).toMatch(/preflight[\s\S]{0,160}launchability/i);
      expect(contents).toMatch(/delivery[\s\S]{0,200}(?:independent|later|outbox)/i);
    }
  });

  it("documents unified Desktop-local discovery and target-aware launch preflight", () => {
    for (const file of [SKILL, "README.md", "doc/operations-guide.md", "skills/build-and-install/SKILL.md"]) {
      const contents = readDoc(file);
      expect(contents).toMatch(/desktop-local/i);
      expect(contents).toMatch(/CODEX_MIMO_CODEX_BIN[\s\S]{0,180}(?:authoritative|override)/i);
    }

    for (const file of ["README.md", "doc/operations-guide.md", SKILL]) {
      const contents = readDoc(file);
      expect(contents).toMatch(/(?:basic CLI readiness|CLI readiness)/i);
      expect(contents).toMatch(/target-aware/i);
      expect(contents).toMatch(/root CLI[\s\S]{0,160}(?:older|version-folder)/i);
    }
  });

  it("covers heartbeat cleanup for failure timeout cancel and needs_input", () => {
    const skill = readDoc(SKILL);
    for (const token of ["needs_input", "cancelled", "timeout", "failed"]) {
      expect(skill).toMatch(new RegExp(token));
    }
    expect(skill).toMatch(/(?:delete|cancel|remove|stop)[\s\S]{0,120}(?:heartbeat|schedule|follow-up)/i);
  });
});
