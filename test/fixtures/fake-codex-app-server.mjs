import fs from "node:fs";
import readline from "node:readline";

const marker = process.env.FAKE_CODEX_MARKER;
if (!marker) throw new Error("FAKE_CODEX_MARKER is required.");

const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  fs.appendFileSync(marker, `${JSON.stringify(message)}\n`, "utf8");
  if (!Number.isInteger(message.id)) continue;

  let result;
  if (message.method === "initialize") {
    result = {
      codexHome: "fake-codex-home",
      platformFamily: "windows",
      platformOs: "windows",
      userAgent: "fake-codex-app-server"
    };
  } else if (message.method === "thread/resume") {
    result = {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      cwd: process.cwd(),
      model: "fake-model",
      modelProvider: "fake-provider",
      sandbox: "read-only",
      thread: {
        cliVersion: "0.0.0",
        createdAt: 0,
        cwd: process.cwd(),
        ephemeral: false,
        id: message.params.threadId,
        modelProvider: "fake-provider",
        preview: "",
        sessionId: message.params.threadId,
        source: "appServer",
        status: { type: "idle" },
        turns: [],
        updatedAt: 0
      }
    };
  } else if (message.method === "turn/start") {
    result = { turn: { id: "turn-fake", items: [], status: "completed" } };
  } else {
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      error: { code: -32601, message: `Unknown method: ${message.method}` }
    })}\n`);
    continue;
  }
  process.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
}
