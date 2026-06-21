import { execa } from "execa";
import { buildMimoRunArgs, type MimoRunOptions } from "./run-json.js";

export interface MimoRunResult {
  sessionId: string | null;
  summary: string;
  changedFiles: string[];
  commands: Array<{ command: string; exitCode: number | null }>;
  errors: string[];
  raw: unknown[];
}

export async function runAndCapture(options: MimoRunOptions): Promise<MimoRunResult> {
  const args = buildMimoRunArgs(options);
  const result = await execa("mimo", args, {
    cwd: options.cwd,
    stdin: "ignore",
    stderr: "pipe",
    reject: false
  });

  const lines = result.stdout.split("\n").filter((l) => l.trim());
  const messages: unknown[] = [];
  for (const line of lines) {
    try { messages.push(JSON.parse(line)); } catch { /* skip non-JSON */ }
  }

  const parsed = parseMimoOutput(messages);
  
  // Include stderr in errors if command failed
  if (result.exitCode !== 0 && result.stderr) {
    parsed.errors.push(result.stderr);
  }

  return parsed;
}

function extractFilePath(obj: Record<string, unknown> | undefined): string | null {
  if (!obj) return null;
  // Check common path field names
  for (const key of ["filepath", "filePath", "path"]) {
    if (typeof obj[key] === "string") return obj[key];
  }
  return null;
}

export function parseMimoOutput(messages: unknown[]): MimoRunResult {
  let sessionId: string | null = null;
  const textParts: string[] = [];
  const changedFiles = new Set<string>();
  const commands: Array<{ command: string; exitCode: number | null }> = [];
  const errors: string[] = [];

  for (const msg of messages) {
    const m = msg as Record<string, unknown>;

    // Support both sessionID and sessionId
    if (typeof m.sessionID === "string") sessionId = m.sessionID;
    if (typeof m.sessionId === "string") sessionId = m.sessionId;

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

  return {
    sessionId,
    summary: textParts.join("\n").trim() || "Completed.",
    changedFiles: [...changedFiles],
    commands,
    errors,
    raw: messages
  };
}
