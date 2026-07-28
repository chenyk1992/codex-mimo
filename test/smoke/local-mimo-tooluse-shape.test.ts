import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { resolveMimoCommand } from "../../src/mimo/run-json.js";

const runSmoke = process.env.RUN_LOCAL_MIMO_HOOK_SMOKE === "1";
const describeSmoke = runSmoke ? describe : describe.skip;

describeSmoke("local MiMoCode tool_use event shape", () => {
  it("captures a real tool_use payload from a file-writing prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-tooluse-"));
    const stdoutLog = path.join(root, "stdout.jsonl");
    const stderrLog = path.join(root, "stderr.txt");
    const stdoutStream = fs.createWriteStream(stdoutLog);
    const stderrStream = fs.createWriteStream(stderrLog);

    const target = path.join(root, "answer.txt");
    const prompt = `Use the write tool to create the file ${target} with the single word "ok". Do not do anything else.`;

    const proc = execa(resolveMimoCommand(), ["run", "--format", "json", prompt], {
      cwd: root,
      reject: false,
      stdin: "ignore"
    });
    proc.stdout?.pipe(stdoutStream);
    proc.stderr?.pipe(stderrStream);
    const result = await proc;
    await new Promise<void>((resolve) => stdoutStream.end(() => resolve()));
    await new Promise<void>((resolve) => stderrStream.end(() => resolve()));

    const rawStdout = fs.readFileSync(stdoutLog, "utf-8");
    const lines = rawStdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const events = lines.map((l) => {
      try { return JSON.parse(l); } catch { return { __parse_error: l }; }
    });

    const toolUseEvents = events.filter((e: { type?: string }) => e.type === "tool_use");
    const writeOrEditEvents = toolUseEvents.filter((e: { part?: { tool?: string } }) =>
      e.part && (e.part.tool === "write" || e.part.tool === "edit" || e.part.tool === "bash")
    );

    const fileOnDiskExists = fs.existsSync(target);

    const report = {
      exitCode: result.exitCode,
      jsonlLineCount: lines.length,
      toolUseCount: toolUseEvents.length,
      writeOrEditEventCount: writeOrEditEvents.length,
      fileOnDiskExists,
      fileOnDiskContent: fileOnDiskExists ? fs.readFileSync(target, "utf-8") : null,
      rawEvents: events,
      sampleToolUseShape: writeOrEditEvents[0]
        ? {
            type: writeOrEditEvents[0].type,
            timestamp: writeOrEditEvents[0].timestamp,
            sessionID: writeOrEditEvents[0].sessionID,
            partKeys: writeOrEditEvents[0].part ? Object.keys(writeOrEditEvents[0].part) : null,
            tool: writeOrEditEvents[0].part?.tool,
            stateKeys: writeOrEditEvents[0].part?.state ? Object.keys(writeOrEditEvents[0].part.state) : null,
            stateInputKeys: writeOrEditEvents[0].part?.state?.input
              ? Object.keys(writeOrEditEvents[0].part.state.input)
              : null,
            stateInputFilePath: writeOrEditEvents[0].part?.state?.input?.file_path,
            stateInputfilepath: writeOrEditEvents[0].part?.state?.input?.filepath,
            stateInputfilePath: writeOrEditEvents[0].part?.state?.input?.filePath,
            stateInputpath: writeOrEditEvents[0].part?.state?.input?.path,
            stateMetadata: writeOrEditEvents[0].part?.state?.metadata,
            stateMetadataKeys: writeOrEditEvents[0].part?.state?.metadata
              ? Object.keys(writeOrEditEvents[0].part.state.metadata)
              : null,
            stateStatus: writeOrEditEvents[0].part?.state?.status,
            stateOutput: writeOrEditEvents[0].part?.state?.output
          }
        : null,
      allToolNames: toolUseEvents.map((e: { part?: { tool?: string } }) => e.part?.tool)
    };

    fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2), "utf-8");
    // eslint-disable-next-line no-console
    console.log("TOOLUSE_REPORT:", JSON.stringify(report, null, 2));

    expect(result.exitCode).toBe(0);
    expect(toolUseEvents.length).toBeGreaterThan(0);
    expect(fileOnDiskExists).toBe(true);
  }, 120_000);
});
