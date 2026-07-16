import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMimoJsonLines } from "../../src/compose/events.js";
import { createComposeReport, writeComposeReport } from "../../src/compose/report.js";
import { buildComposePrompt, getComposeWorkflow } from "../../src/compose/workflow.js";
import { preparePromptTransport } from "../../src/mimo/prompt-transport.js";

describe("Windows UTF-8 encoding regressions", () => {
  const sample = "基于 Windows 本地执行器 — 🎬";

  it("tells Windows workflows to read text and run Python with UTF-8", () => {
    const prompt = buildComposePrompt({
      workflow: getComposeWorkflow("fix"),
      task: "Read a UTF-8 report and diagnose it."
    });

    expect(prompt).toContain("Get-Content -Encoding UTF8");
    expect(prompt).not.toContain("Get-Content | Measure-Object");
    expect(prompt).toContain("PYTHONUTF8=1");
    expect(prompt).toContain("PYTHONIOENCODING=utf-8");
  });

  it("preserves UTF-8 text through prompt files, MiMo JSONL, and Markdown reports", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-utf8-"));
    const prompt = `Objective: ${sample}`;
    const transported = preparePromptTransport(prompt, { cwd, forceFile: true });
    const promptFile = transported.files[0];

    expect(fs.readFileSync(promptFile)).toEqual(Buffer.from(prompt, "utf-8"));
    expect(fs.readFileSync(promptFile, "utf-8")).toBe(prompt);
    expect(transported.message).toContain("UTF-8");
    expect(transported.message).toContain("Get-Content -Encoding UTF8");

    const report = createComposeReport({
      id: "utf8-run",
      createdAt: "2026-06-29T00:00:00.000Z",
      cwd,
      workflow: "fix",
      task: prompt,
      mimoArgs: ["run", "--format", "json"],
      requestedSkills: ["compose:debug", "compose:tdd", "compose:verify", "compose:feedback"],
      events: parseMimoJsonLines(`${JSON.stringify({ type: "message", text: sample })}\n`),
      diff: { changedFiles: [], diffStat: "", diff: "" },
      verification: [],
      reportDir: path.join(cwd, ".codex-mimo", "reports"),
      eventsDir: path.join(cwd, ".codex-mimo", "events"),
      diffsDir: path.join(cwd, ".codex-mimo", "diffs"),
      status: "passed"
    });

    writeComposeReport(report);

    expect(report.reviewText).toBe(sample);
    expect(fs.readFileSync(report.reportPaths.markdown).indexOf(Buffer.from(sample, "utf-8"))).not.toBe(-1);
    expect(fs.readFileSync(report.reportPaths.markdown, "utf-8")).toContain(sample);
    expect(fs.readFileSync(report.reportPaths.eventsJsonl, "utf-8")).toContain(sample);
  });
});
