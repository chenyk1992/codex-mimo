import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { resolveMimoCommand } from "../../src/mimo/run-json.js";
import { createHookCallbackController } from "../../src/mimo/hook-callback.js";

const runSmoke = process.env.RUN_LOCAL_MIMO_HOOK_SMOKE === "1";
const describeSmoke = runSmoke ? describe : describe.skip;

function writeFileHookProject(root: string): string {
  const hookDir = path.join(root, ".mimocode", "hooks");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(
    path.join(hookDir, "cancel.js"),
    `
import fs from "node:fs/promises";

const marker = new URL("./marker.json", import.meta.url);

export default {
  "session.pre": async (_input, output) => {
    output.cancel = true;
    output.cancelReason = "local smoke";
  },
  "session.post": async (input) => {
    await fs.writeFile(marker, JSON.stringify(input, null, 2), "utf8");
  }
};
`,
    "utf-8"
  );
  return path.join(hookDir, "marker.json");
}

function writeCancelHookToConfigDir(configDir: string): void {
  const hookDir = path.join(configDir, "hooks");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(
    path.join(hookDir, "cancel.js"),
    `
export default {
  "session.pre": async (_input, output) => {
    output.cancel = true;
    output.cancelReason = "local smoke";
  }
};
`,
    "utf-8"
  );
}

describeSmoke("local MiMoCode hooks", () => {
  it("fires session.post for file-hook mode without a model call", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-local-hook-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-local-home-"));
    const marker = writeFileHookProject(root);

    const result = await execa(resolveMimoCommand(), ["run", "--format", "json", "local hook smoke"], {
      cwd: root,
      reject: false,
      stdin: "ignore",
      env: { MIMOCODE_HOME: home }
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(fs.readFileSync(marker, "utf-8")) as { outcome?: string; error?: string };
    expect(payload.outcome).toBe("cancelled");
    expect(payload.error).toBe("local smoke");
  }, 60_000);

  it("loads Codex-MiMo runtime hooks through MIMOCODE_CONFIG_DIR", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-runtime-hook-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-runtime-home-"));
    const hook = await createHookCallbackController({
      cwd: root,
      kind: "smoke",
      callbackWaitMs: 15_000
    });
    writeCancelHookToConfigDir(hook.configDir);

    try {
      const result = await execa(resolveMimoCommand(), ["run", "--format", "json", "runtime hook smoke"], {
        cwd: root,
        reject: false,
        stdin: "ignore",
        env: { ...hook.env, MIMOCODE_HOME: home }
      });

      expect(result.exitCode).toBe(0);
      const callback = await hook.waitForCallback();
      expect(callback).toMatchObject({
        invocationId: hook.invocationId,
        outcome: "cancelled",
        error: "local smoke"
      });
      expect(callback?.sessionId).toBeTruthy();
    } finally {
      await hook.close();
    }
  }, 60_000);
});
