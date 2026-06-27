import { execa } from "execa";
import { buildMimoRunArgs, type MimoRunOptions, resolveMimoCommand } from "./run-json.js";
import { preparePromptTransport } from "./prompt-transport.js";
import { createHookCallbackController, type MimoHookCallbackSummary } from "./hook-callback.js";

export interface MimoRunResult {
  sessionId: string | null;
  summary: string;
  changedFiles: string[];
  commands: Array<{ command: string; exitCode: number | null }>;
  errors: string[];
  exitCode: number;
  raw: unknown[];
  callback?: MimoHookCallbackSummary | null;
  callbackTimedOut?: boolean;
}

export async function runAndCapture(options: MimoRunOptions & { timeoutMs?: number }): Promise<MimoRunResult> {
  const transported = preparePromptTransport(options.message, { cwd: options.cwd });
  const args = buildMimoRunArgs({
    ...options,
    message: transported.message,
    files: [...transported.files, ...(options.files ?? [])]
  });
  const hook = await createHookCallbackController({
    cwd: options.cwd,
    kind: "mimo-run",
    callbackWaitMs: options.timeoutMs
      ? Math.min(10_000, Math.max(1_000, options.timeoutMs))
      : undefined
  });

  try {
    let result: Awaited<ReturnType<typeof execa>>;
    try {
      result = await execa(resolveMimoCommand(), args, {
        cwd: options.cwd,
        stdin: "ignore",
        stderr: "pipe",
        timeout: options.timeoutMs,
        reject: false,
        env: hook.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        sessionId: null,
        summary: "MiMoCode failed to start.",
        changedFiles: [],
        commands: [],
        errors: [message],
        exitCode: 1,
        raw: [],
        callback: null,
        callbackTimedOut: true
      };
    }

    const stdout = typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? "");
    const stderr = typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? "");
    const timedOut = Boolean((result as { timedOut?: boolean }).timedOut);
    const processExitCode = timedOut ? 124 : result.exitCode ?? 1;
    const callback = timedOut ? null : await hook.waitForCallback();
    const lines = stdout.split("\n").filter((line) => line.trim());
    const messages: unknown[] = [];
    for (const line of lines) {
      try { messages.push(JSON.parse(line)); } catch { /* skip non-JSON */ }
    }

    const parsed = parseMimoOutput(messages, callback);
    
    // Include stderr in errors if command failed
    if (processExitCode !== 0 && stderr) {
      parsed.errors.push(stderr);
    }

    if (timedOut) {
      parsed.errors.push("MiMoCode exceeded the configured process timeout.");
    } else if (callback === null) {
      parsed.errors.push("MiMoCode hook callback timed out before session.post was received.");
    }

    return {
      ...parsed,
      callbackTimedOut: callback === null,
      exitCode: processExitCode === 0
        ? (callback === null ? 1 : parsed.exitCode)
        : processExitCode
    };
  } finally {
    await hook.close();
  }
}

function extractFilePath(obj: Record<string, unknown> | undefined): string | null {
  if (!obj) return null;
  // Check common path field names
  for (const key of ["filepath", "filePath", "path"]) {
    if (typeof obj[key] === "string") return obj[key];
  }
  return null;
}

export function parseMimoOutput(messages: unknown[], callback: MimoHookCallbackSummary | null = null): MimoRunResult {
  let sessionId: string | null = callback?.sessionId ?? null;
  const textParts: string[] = [];
  const changedFiles = new Set<string>();
  const commands: Array<{ command: string; exitCode: number | null }> = [];
  const errors: string[] = [];
  let exitCode = 0;

  for (const msg of messages) {
    const m = msg as Record<string, unknown>;

    // Support both sessionID and sessionId
    if (!callback && typeof m.sessionID === "string") sessionId = m.sessionID;
    if (!callback && typeof m.sessionId === "string") sessionId = m.sessionId;

    if (m.type === "text") {
      const part = m.part as Record<string, unknown> | undefined;
      if (part && typeof part.text === "string") textParts.push(part.text);
    }

    if (m.type === "error") {
      const part = m.part as Record<string, unknown> | undefined;
      const msg = (part?.message as string) ?? (part?.text as string) ?? (m.message as string);
      if (msg) errors.push(msg);
    }

    if (m.type === "tool_use") {
      const part = m.part as Record<string, unknown> | undefined;
      if (part) {
        const state = part.state as Record<string, unknown> | undefined;
        
        // Capture changed files from mutating file operations.
        if ((part.tool === "write" || part.tool === "edit") && state) {
          const fp =
            extractFilePath(part) ??
            extractFilePath(state) ??
            extractFilePath(state.metadata as Record<string, unknown> | undefined) ??
            extractFilePath(state.input as Record<string, unknown> | undefined);
          if (fp) changedFiles.add(fp);
        }

        // Capture bash commands
        if (part.tool === "bash" && state) {
          const input = state.input as Record<string, unknown> | undefined;
          const cmd = (input?.command as string) ?? "";
          const exit = (state.metadata as Record<string, unknown>)?.exit;
          commands.push({ command: cmd, exitCode: typeof exit === "number" ? exit : null });
        }
      }
    }
  }

  if (callback?.outcome === "cancelled") {
    exitCode = 1;
    errors.push(`MiMoCode cancelled: ${callback.error ?? "cancelled by hook"}`);
  }

  if (callback?.outcome === "error") {
    exitCode = 1;
    errors.push(`MiMoCode error: ${callback.error ?? "hook reported an error"}`);
  }

  const callbackFinalText = callback?.finalText?.trim();

  return {
    sessionId,
    summary: callbackFinalText || textParts.join("\n").trim() || "Completed.",
    changedFiles: [...changedFiles],
    commands,
    errors,
    exitCode,
    raw: messages,
    callback
  };
}
