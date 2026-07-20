#!/usr/bin/env node
import {
  handleAfterMcp,
  handleStop,
  readState,
  watchStatePath,
  writeState
} from "./watch.js";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(String(chunk)));
    process.stdin.on("end", () => resolve(chunks.join("")));
    process.stdin.on("error", reject);
  });
}

function writeStdout(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(argv: string[]): Promise<void> {
  const mode = argv[2] ?? "";
  const raw = await readStdin();
  let payload: Record<string, unknown> = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch {
    writeStdout({});
    return;
  }

  try {
    const file = watchStatePath();
    const state = readState(file);
    if (mode === "after-mcp") {
      const result = handleAfterMcp(payload, state);
      writeState(file, result.nextState);
      writeStdout(result.output);
      return;
    }
    if (mode === "stop") {
      const hookTimeoutSec = Number(process.env.CODEX_MIMO_COMPANION_HOOK_TIMEOUT_SEC ?? "1860");
      const result = await handleStop(payload, state, {
        hookTimeoutMs: (Number.isFinite(hookTimeoutSec) && hookTimeoutSec > 0 ? hookTimeoutSec : 1860) * 1000
      });
      writeState(file, result.nextState);
      writeStdout(result.output);
      return;
    }
    writeStdout({});
  } catch (error) {
    process.stderr.write(`[mimo-companion] ${error instanceof Error ? error.message : String(error)}\n`);
    writeStdout({});
  }
}

await main(process.argv);
