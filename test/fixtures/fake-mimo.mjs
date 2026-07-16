const finalText = process.env.FAKE_MIMO_FINAL_TEXT ?? "Job completed from fake MiMo.";

process.stdout.write(`${JSON.stringify({
  type: "text",
  timestamp: new Date().toISOString(),
  sessionID: "session-fake",
  text: finalText
})}\n`);

if (process.env.FAKE_MIMO_MODE === "hang") {
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
