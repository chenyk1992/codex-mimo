import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const finalText = process.env.FAKE_MIMO_FINAL_TEXT ?? "Job completed from fake MiMo.";
const sessionId = process.env.FAKE_MIMO_SESSION_ID ?? "session-fake";
const childSessionId = process.env.FAKE_MIMO_CHILD_SESSION_ID;
const callbackSessionId = process.env.FAKE_MIMO_CALLBACK_SESSION_ID ?? sessionId;
const childCallbackSessionId = process.env.FAKE_MIMO_CHILD_CALLBACK_SESSION_ID;
const userQuery = process.env.FAKE_MIMO_USER_QUERY ?? process.argv.slice(2).join(" ");
const emitTools = process.env.FAKE_MIMO_EMIT_TOOLS === "1";
const runHooks = process.env.FAKE_MIMO_RUN_HOOKS === "1";
const exitCode = Number.parseInt(process.env.FAKE_MIMO_EXIT_CODE ?? "0", 10);

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

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function toolUseEvent(tool, input, session = sessionId) {
  return {
    type: "tool_use",
    timestamp: new Date().toISOString(),
    sessionID: session,
    part: {
      type: "tool",
      tool,
      state: {
        input,
        metadata: tool === "bash" ? { exit: 0 } : {}
      }
    }
  };
}

async function loadHookPlugin() {
  const configDir = process.env.MIMOCODE_CONFIG_DIR;
  if (!configDir) return undefined;
  const pluginDir = path.join(configDir, "plugin");
  if (!fs.existsSync(pluginDir)) return undefined;
  const entries = fs.readdirSync(pluginDir).filter((name) => /\.(mjs|js|cjs)$/.test(name));
  if (entries.length === 0) return undefined;
  const hookFile = path.join(pluginDir, entries[0]);
  const mod = await import(pathToFileURL(hookFile).href);
  const factory = mod.default ?? mod;
  if (typeof factory !== "function") return undefined;
  return factory();
}

async function invokeHook(hooks, name, input, output = {}) {
  const handler = hooks?.[name];
  if (typeof handler !== "function") return output;
  await handler(input, output);
  return output;
}

async function postCallback(targetSessionId, outcome = "completed") {
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
      sessionID: targetSessionId,
      agentID: "fake-agent",
      task_id: "fake-task",
      outcome,
      finalText
    })
  });
  if (!response.ok) {
    throw new Error(`Fake MiMo callback failed with HTTP ${response.status}.`);
  }
}

let cancelledByHook = false;
let hooks;
if (runHooks) {
  hooks = await loadHookPlugin();
  if (hooks) {
    await invokeHook(hooks, "session.pre", { sessionID: sessionId });
    if (childSessionId) {
      await invokeHook(hooks, "session.pre", { sessionID: childSessionId });
    }
    const queryOutput = await invokeHook(
      hooks,
      "session.userQuery.pre",
      { sessionID: sessionId, query: userQuery },
      { cancel: false }
    );
    if (queryOutput.cancel) {
      cancelledByHook = true;
      emit({
        type: "error",
        timestamp: new Date().toISOString(),
        sessionID: sessionId,
        error: queryOutput.cancelReason ?? "cancelled by session.userQuery.pre"
      });
    }
  }
}

if (!cancelledByHook) {
  if (emitTools) {
    emit(toolUseEvent("bash", { command: "echo probe" }));
    const writePath = process.env.FAKE_MIMO_WRITE_PATH ?? "src/out-of-scope.ts";
    let blocked = false;
    if (hooks) {
      const toolOutput = await invokeHook(
        hooks,
        "tool.execute.before",
        {
          sessionID: sessionId,
          tool: "write",
          part: { state: { input: { file_path: writePath } } }
        },
        { cancel: false }
      );
      blocked = Boolean(toolOutput.cancel);
      if (blocked) {
        emit({
          type: "error",
          timestamp: new Date().toISOString(),
          sessionID: sessionId,
          error: toolOutput.cancelReason ?? "cancelled by tool.execute.before"
        });
      }
    }
    if (!blocked) {
      emit(toolUseEvent("write", { file_path: writePath }));
    }
  }

  const textEvent = process.env.FAKE_MIMO_NESTED_TEXT === "1"
    ? {
        type: "text",
        timestamp: new Date().toISOString(),
        sessionID: sessionId,
        part: { type: "text", text: finalText }
      }
    : {
        type: "text",
        timestamp: new Date().toISOString(),
        sessionID: sessionId,
        text: finalText
      };
  emit(textEvent);

  if (process.env.FAKE_MIMO_SECOND_SESSION_ID) {
    emit({
      type: "text",
      timestamp: new Date().toISOString(),
      sessionID: process.env.FAKE_MIMO_SECOND_SESSION_ID,
      text: "secondary session event"
    });
  }
}

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
  const outcome = cancelledByHook ? "cancelled" : "completed";
  // Child callback can arrive before the primary session callback.
  if (childCallbackSessionId) {
    await postCallback(childCallbackSessionId, "completed");
  }
  if (hooks) {
    if (childSessionId) {
      await invokeHook(hooks, "session.post", {
        sessionID: childSessionId,
        outcome: "completed"
      });
    }
    await invokeHook(hooks, "session.post", {
      sessionID: sessionId,
      outcome
    });
  } else {
    await postCallback(callbackSessionId, outcome);
  }
}

if (Number.isFinite(exitCode) && exitCode !== 0) {
  process.exitCode = exitCode;
}
