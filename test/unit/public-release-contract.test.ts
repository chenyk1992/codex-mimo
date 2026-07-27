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

  it("documents compact default results and explicit full diagnostics", () => {
    for (const file of ALL_DOCS) {
      const contents = readDoc(file);
      expect(contents).toMatch(/mimo_result[\s\S]{0,120}(?:compact|default)/i);
      expect(contents).toMatch(/(?:level|output level)[\s\S]{0,120}full/i);
      expect(contents).toMatch(/report path|saved plan|plan artifact/i);
      expect(contents).not.toMatch(/answer from `?mimo_result\.output`? when present/i);
    }
  });

  it("documents structural reports plus separate semantic artifacts", () => {
    for (const file of USER_DOCS) {
      const contents = readDoc(file);
      expect(contents).toMatch(/structural/i);
      expect(contents).toMatch(/\.result\.md/);
      expect(contents).toMatch(/\.plan\.md/);
      expect(contents).toMatch(/\.verification\.json/);
      expect(contents).toMatch(/(?:do not|omit)[\s\S]{0,100}(?:inline|model output|stdout|stderr)/i);
    }
    for (const file of ["README.md", "doc/operations-guide.md"]) {
      expect(readDoc(file)).toMatch(/artifact_too_large/);
    }
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

  it("documents compact heartbeat consumption in the skill", () => {
    const skill = readDoc(SKILL);
    expect(skill).toMatch(/heartbeat[\s\S]{0,220}mimo_status[\s\S]{0,120}compact/i);
    expect(skill).toMatch(/mimo_result[\s\S]{0,120}reportPath|report path/i);
    expect(skill).toMatch(/manual|diagnos|troubleshoot[\s\S]{0,160}full/i);
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

  it("covers heartbeat cleanup for failure timeout cancel needs_input and stalled", () => {
    const skill = readDoc(SKILL);
    for (const token of ["needs_input", "stalled", "cancelled", "timeout", "failed"]) {
      expect(skill).toMatch(new RegExp(token));
    }
    expect(skill).toMatch(/(?:delete|cancel|remove|stop)[\s\S]{0,120}(?:heartbeat|schedule|follow-up)/i);
  });

  it("documents effective-progress stop-loss and stalled attention", () => {
    for (const file of ALL_DOCS) {
      const contents = readDoc(file);
      expect(contents).toMatch(/stalled/);
      expect(contents).toMatch(/progressTimeoutMs/);
      expect(contents).toMatch(/effective.?progress|no effective progress/i);
    }
    for (const file of USER_DOCS) {
      const contents = readDoc(file);
      expect(contents).toMatch(/progressWarningMs|2.?minute|120[_,]?000/i);
      expect(contents).toMatch(/5.?minute|300[_,]?000/i);
      expect(contents).toMatch(/idleTimeoutMs/);
      expect(contents).toMatch(/30.?minute|1[_,]?800[_,]?000/i);
    }
  });

  it("documents checkpoint artifact path and mimo_resume for stalled or timeout", () => {
    for (const file of USER_DOCS) {
      const contents = readDoc(file);
      expect(contents).toMatch(/\.checkpoint\.json/);
      expect(contents).toMatch(/mimo_resume[\s\S]{0,240}(?:stalled|timeout)/i);
    }
    const skill = readDoc(SKILL);
    expect(skill).toMatch(/mimo_resume[\s\S]{0,280}(?:stalled|timeout|needs_input|blocked)/i);
    expect(skill).toMatch(/\.checkpoint\.json/);
  });

  it("warns that progressTimeoutMs 0 weakens deliverability", () => {
    for (const file of USER_DOCS) {
      const contents = readDoc(file);
      expect(contents).toMatch(/progressTimeoutMs:\s*0|progressTimeoutMs[^\n]{0,80}\b0\b/i);
      expect(contents).toMatch(/weakens|disables[^\n]{0,120}(?:effective|progress|stop-loss|deliverability)/i);
    }
  });

  it("documents ordered development acceptance for write workflows", () => {
    for (const file of ALL_DOCS) {
      const contents = readDoc(file);
      expect(contents).toMatch(/acceptance\.build|acceptance:\s*\{[\s\S]{0,80}build/);
      expect(contents).toMatch(/acceptance\.test|["']test["']\s*:/);
      expect(contents).toMatch(/diffCheck/);
      expect(contents).toMatch(/build_failed/);
      expect(contents).toMatch(/tests_failed/);
      expect(contents).toMatch(/diff_check_failed/);
      expect(contents).toMatch(/acceptance_config_missing/);
      expect(contents).toMatch(/delivery_contract_missing/);
      expect(contents).toMatch(/fail-?fast|ordered[\s\S]{0,80}(?:stage|acceptance)/i);
      expect(contents).toMatch(/verification[\s\S]{0,120}(?:test stage|maps to(?: the)? test)/i);
      expect(contents).toMatch(/`?dev`?[\s\S]{0,200}`?execute-plan`?[\s\S]{0,200}`?implement`?|`?implement`?[\s\S]{0,200}`?dev`?/i);
      expect(contents).toMatch(/(?:cannot|must not|never)[\s\S]{0,80}complet[\s\S]{0,120}acceptance|without acceptance[\s\S]{0,80}complet/i);
    }

    for (const file of USER_DOCS) {
      const contents = readDoc(file);
      expect(contents).toMatch(/failedStage|failed stage|first failed stage/i);
      expect(contents).toMatch(/suggestion|shortest[\s\S]{0,40}(?:fix|next)/i);
      expect(contents).toMatch(
        /mimo_resume[\s\S]{0,280}(?:build_failed|tests_failed|diff_check_failed|delivery_contract_missing)/i
      );
    }
  });

  it("documents batchMode slice chains, root-only notify, and slice failure codes", () => {
    for (const file of ALL_DOCS) {
      const contents = readDoc(file);
      expect(contents).toMatch(/batchMode/);
      expect(contents).toMatch(/auto/);
      expect(contents).toMatch(/single/);
      expect(contents).toMatch(/sliced/);
      expect(contents).toMatch(/slice_plan_invalid/);
      expect(contents).toMatch(/slice_failed/);
      expect(contents).toMatch(/\.slices\.json/);
      expect(contents).toMatch(/\.chain\.json|jobs\/<chainId>\.chain\.json/);
      expect(contents).toMatch(/one slice at a time|sequential(?:ly)?|one-slice-at-a-time/i);
      expect(contents).toMatch(/root-only|only the (?:public )?root|children (?:omit|never) notify|null notification/i);
      expect(contents).toMatch(/skip(?:s|ping)? completed slices|never relaunches completed/i);
    }
  });
});
