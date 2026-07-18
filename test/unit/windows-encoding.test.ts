import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMimoJsonLines } from "../../src/compose/events.js";
import { createComposeReport, writeComposeReport } from "../../src/compose/report.js";
import { buildComposePrompt, getComposeWorkflow } from "../../src/compose/workflow.js";
import { preparePromptTransport } from "../../src/mimo/prompt-transport.js";
import { omitEnvironmentVariables, withUtf8ProcessEnv } from "../../src/core/encoding.js";

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

  it("preserves UTF-8 prompt files without persisting MiMo message text in reports", () => {
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

    expect(fs.readFileSync(report.reportPaths.markdown, "utf-8")).not.toContain(sample);
    expect(fs.readFileSync(report.reportPaths.eventsJsonl, "utf-8")).not.toContain(sample);
    expect(fs.readFileSync(report.reportPaths.eventsJsonl, "utf-8")).toContain('"type":"message"');
  });
});

describe("process environment omission semantics", () => {
  it("omits a lower-case Windows secret when its configured name is upper-case", () => {
    const source = { webhook_secret: "secret", UNRELATED_VALUE: "kept" };
    const result = omitEnvironmentVariables(source, ["WEBHOOK_SECRET"], { caseInsensitive: true });

    expect(result).toEqual({ UNRELATED_VALUE: "kept" });
    expect(source).toEqual({ webhook_secret: "secret", UNRELATED_VALUE: "kept" });
  });

  it("omits every Windows casing when the configured secret name is lower-case", () => {
    const source = {
      WEBHOOK_SECRET: "upper-secret",
      WebHook_Secret: "mixed-secret",
      webhook_secret: "lower-secret",
      CODEX_MIMO_CALLBACK_TOKEN: "callback-token"
    };
    const base = { webhook_secret: "base-secret", BASE_VALUE: "kept" };
    const beforeProcessEnv = { ...process.env };
    const result = withUtf8ProcessEnv(source, {
      base,
      omit: ["webhook_secret"],
      platform: "win32"
    });

    expect(Object.keys(result).filter((key) => key.toLowerCase() === "webhook_secret")).toEqual([]);
    expect(result.CODEX_MIMO_CALLBACK_TOKEN).toBe("callback-token");
    expect(result).toMatchObject({ PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
    expect(source).toEqual({
      WEBHOOK_SECRET: "upper-secret",
      WebHook_Secret: "mixed-secret",
      webhook_secret: "lower-secret",
      CODEX_MIMO_CALLBACK_TOKEN: "callback-token"
    });
    expect(base).toEqual({ webhook_secret: "base-secret", BASE_VALUE: "kept" });
    expect(process.env).toEqual(beforeProcessEnv);
  });

  it("keeps POSIX environment omission case-sensitive", () => {
    const result = withUtf8ProcessEnv(
      { WEBHOOK_SECRET: "keep-upper", webhook_secret: "remove-lower" },
      { base: {}, omit: ["webhook_secret"], platform: "linux" }
    );

    expect(result.WEBHOOK_SECRET).toBe("keep-upper");
    expect(result.webhook_secret).toBeUndefined();
  });
});
