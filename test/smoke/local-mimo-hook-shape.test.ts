import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { resolveMimoCommand } from "../../src/mimo/run-json.js";
import { createHookCallbackController } from "../../src/mimo/hook-callback.js";

const runSmoke = process.env.RUN_LOCAL_MIMO_HOOK_SMOKE === "1";
const describeSmoke = runSmoke ? describe : describe.skip;

function writeFullHookProject(root: string, markerPath: string): void {
  const pluginDir = path.join(root, ".mimocode", "plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "capture.js"),
    `
import fs from "node:fs/promises";

const marker = ${JSON.stringify(markerPath)};

async function dump(stage, input) {
  try {
    await fs.writeFile(marker + "." + stage + ".json", JSON.stringify(input ?? null, null, 2), "utf8");
  } catch (e) {
    await fs.writeFile(marker + "." + stage + ".err.txt", String(e?.stack ?? e), "utf8");
  }
}

export default async function capturePlugin() {
  return {
    "session.pre": async (input, output) => {
      await dump("pre", { input, output });
    },
    "session.post": async (input) => {
      await dump("post", input);
    }
  };
}
`,
    "utf-8"
  );
}

describeSmoke("local MiMoCode hook payload shape", () => {
  it("captures session.pre + session.post payload + raw JSONL", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-shape-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-shape-home-"));
    const marker = path.join(root, "marker.json");
    writeFullHookProject(root, marker);

    const stdoutLog = path.join(root, "stdout.jsonl");
    const stderrLog = path.join(root, "stderr.txt");
    const stdoutStream = fs.createWriteStream(stdoutLog);
    const stderrStream = fs.createWriteStream(stderrLog);

    const proc = execa(resolveMimoCommand(), ["run", "--format", "json", "respond with the single word: ok"], {
      cwd: root,
      reject: false,
      stdin: "ignore",
      env: { MIMOCODE_HOME: home }
    });
    proc.stdout?.pipe(stdoutStream);
    proc.stderr?.pipe(stderrStream);

    const result = await proc;
    await new Promise<void>((resolve) => stdoutStream.end(() => resolve()));
    await new Promise<void>((resolve) => stderrStream.end(() => resolve()));

    // Read all three capture artifacts and stdout
    const prePayload = fs.existsSync(marker + ".pre.json") ? JSON.parse(fs.readFileSync(marker + ".pre.json", "utf-8")) : null;
    const postPayload = fs.existsSync(marker + ".post.json") ? JSON.parse(fs.readFileSync(marker + ".post.json", "utf-8")) : null;
    const rawStdout = fs.readFileSync(stdoutLog, "utf-8");
    const lines = rawStdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const parsed = lines.map((l) => {
      try { return JSON.parse(l); } catch { return { __parse_error: l }; }
    });
    const typeCounts: Record<string, number> = {};
    const toolSamples: Array<Record<string, unknown>> = [];
    for (const ev of parsed) {
      const t = (ev as { type?: string }).type ?? "<no-type>";
      typeCounts[t] = (typeCounts[t] ?? 0) + 1;
      if (t === "tool_use") {
        const part = (ev as { part?: { tool?: string; state?: { input?: Record<string, unknown>; metadata?: Record<string, unknown> } } }).part;
        if (part && toolSamples.length < 3) {
          toolSamples.push({ tool: part.tool, inputKeys: Object.keys(part.state?.input ?? {}), metadata: part.state?.metadata });
        }
      }
    }

    // Surface findings in the test report
    const report = {
      exitCode: result.exitCode,
      jsonlLineCount: lines.length,
      eventTypeCounts: typeCounts,
      toolSamples,
      prePayloadKeys: prePayload ? Object.keys(prePayload.input ?? {}) : null,
      postPayloadKeys: postPayload ? Object.keys(postPayload) : null,
      postHasFinalText: postPayload && typeof (postPayload as Record<string, unknown>).finalText === "string",
      postFinalTextSample: postPayload && typeof (postPayload as Record<string, unknown>).finalText === "string"
        ? String((postPayload as Record<string, unknown>).finalText).slice(0, 200)
        : null,
      postOutcome: postPayload && (postPayload as Record<string, unknown>).outcome,
      postSessionID: postPayload && (postPayload as Record<string, unknown>).sessionID,
      postAgentID: postPayload && (postPayload as Record<string, unknown>).agentID,
      postTaskId: postPayload && (postPayload as Record<string, unknown>).task_id,
      postAssistantMessageID: postPayload && (postPayload as Record<string, unknown>).assistantMessageID,
      postMetadataKeys: postPayload && (postPayload as Record<string, unknown>).metadata ? Object.keys((postPayload as Record<string, unknown>).metadata as Record<string, unknown>) : null,
      postTrajectoryLength: postPayload && (postPayload as Record<string, unknown>).metadata ? ((postPayload as Record<string, unknown>).metadata as Record<string, unknown>).trajectoryLength : null,
      firstEventKeys: parsed[0] ? Object.keys(parsed[0] as object) : null
    };

    fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2), "utf-8");
    // eslint-disable-next-line no-console
    console.log("HOOK_PAYLOAD_REPORT:", JSON.stringify(report, null, 2));

    expect(result.exitCode).toBe(0);
    expect(parsed.length).toBeGreaterThan(0);
    expect(postPayload).toBeTruthy();
  }, 60_000);

  it("confirms createHookCallbackController receives the same payload over HTTP", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-runtime-shape-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-runtime-shape-home-"));
    const hook = await createHookCallbackController({
      cwd: root,
      kind: "smoke-shape",
      callbackWaitMs: 15_000
    });

    try {
      const stdoutLog = path.join(root, "stdout.jsonl");
      const stdoutStream = fs.createWriteStream(stdoutLog);
      const proc = execa(resolveMimoCommand(), ["run", "--format", "json", "respond with the single word: pong"], {
        cwd: root,
        reject: false,
        stdin: "ignore",
        env: { ...hook.env, MIMOCODE_HOME: home }
      });
      proc.stdout?.pipe(stdoutStream);
      const result = await proc;
      stdoutStream.end();

      const callback = await hook.waitForCallback();

      const report = {
        exitCode: result.exitCode,
        callbackReceived: callback !== null,
        callbackKeys: callback ? Object.keys(callback) : null,
        callbackOutcome: callback?.outcome,
        callbackError: callback?.error,
        callbackSessionId: callback?.sessionId,
        callbackAgentId: callback?.agentId,
        callbackTaskId: callback?.taskId,
        callbackAssistantMessageId: callback?.assistantMessageId,
        callbackTrajectoryLength: callback?.trajectoryLength,
        callbackFinalTextSample: callback?.finalText?.slice(0, 200) ?? null
      };
      fs.writeFileSync(path.join(root, "runtime-report.json"), JSON.stringify(report, null, 2), "utf-8");
      // eslint-disable-next-line no-console
      console.log("RUNTIME_CALLBACK_REPORT:", JSON.stringify(report, null, 2));

      expect(result.exitCode).toBe(0);
      expect(callback).toBeTruthy();
      expect(callback?.sessionId).toBeTruthy();
      expect(typeof callback?.finalText).toBe("string");
    } finally {
      await hook.close();
    }
  }, 60_000);
});
