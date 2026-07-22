import fs from "node:fs";
import { spawn } from "node:child_process";

const finalText = process.env.FAKE_MIMO_FINAL_TEXT ?? "Job completed from fake MiMo.";

if (process.env.FAKE_MIMO_INVOCATIONS_FILE) {
  fs.appendFileSync(process.env.FAKE_MIMO_INVOCATIONS_FILE, `${process.pid}\n`, "utf8");
}

if (process.env.FAKE_MIMO_SECRET_PROBE_FILE && process.env.FAKE_MIMO_SECRET_PROBE_NAME) {
  fs.writeFileSync(
    process.env.FAKE_MIMO_SECRET_PROBE_FILE,
    process.env[process.env.FAKE_MIMO_SECRET_PROBE_NAME] === undefined ? "missing" : "present",
    "utf8"
  );
}

const textEvent = process.env.FAKE_MIMO_NESTED_TEXT === "1"
  ? {
      type: "text",
      timestamp: new Date().toISOString(),
      sessionID: "session-fake",
      part: { type: "text", text: finalText }
    }
  : {
      type: "text",
      timestamp: new Date().toISOString(),
      sessionID: "session-fake",
      text: finalText
    };
process.stdout.write(`${JSON.stringify(textEvent)}\n`);

if (process.env.FAKE_MIMO_MODE === "hang") {
  const descendant = process.env.FAKE_MIMO_TREE === "1"
    ? spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
        stdio: "ignore",
        windowsHide: true
      })
    : undefined;
  if (process.env.FAKE_MIMO_CHECKPOINT_FILE) {
    fs.writeFileSync(process.env.FAKE_MIMO_CHECKPOINT_FILE, JSON.stringify({
      pid: process.pid,
      descendantPid: descendant?.pid ?? null
    }), "utf8");
  }
  setInterval(() => undefined, 1_000);
} else if (process.env.FAKE_MIMO_CALLBACK === "1") {
  const endpoint = process.env.CODEX_MIMO_CALLBACK_ENDPOINT;
  const token = process.env.CODEX_MIMO_CALLBACK_TOKEN;
  const invocationId = process.env.CODEX_MIMO_INVOCATION_ID;
  if (!endpoint || !token || !invocationId) {
    throw new Error("Fake MiMo callback environment is incomplete.");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-mimo-callback-token": token
    },
    body: JSON.stringify({
      invocationId,
      event: "session.post",
      timestamp: new Date().toISOString(),
      sessionID: "session-fake",
      agentID: "fake-agent",
      task_id: "fake-task",
      outcome: "completed",
      finalText
    })
  });
  if (!response.ok) throw new Error(`Fake MiMo callback failed with HTTP ${response.status}.`);
}
