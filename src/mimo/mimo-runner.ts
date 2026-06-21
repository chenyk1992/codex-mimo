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
    stderr: "pipe"
  });

  const lines = result.stdout.split("\n").filter((l) => l.trim());
  const messages: unknown[] = [];
  for (const line of lines) {
    try { messages.push(JSON.parse(line)); } catch { /* skip non-JSON */ }
  }

  return parseMimoOutput(messages);
}

function parseMimoOutput(messages: unknown[]): MimoRunResult {
  let sessionId: string | null = null;
  const textParts: string[] = [];
  const changedFiles = new Set<string>();
  const commands: Array<{ command: string; exitCode: number | null }> = [];
  const errors: string[] = [];

  for (const msg of messages) {
    const m = msg as Record<string, unknown>;

    if (typeof m.sessionID === "string") sessionId = m.sessionID;

    if (m.type === "text") {
      const part = m.part as Record<string, unknown> | undefined;
      if (part && typeof part.text === "string") textParts.push(part.text);
    }

    if (m.type === "tool_use") {
      const part = m.part as Record<string, unknown> | undefined;
      if (part) {
        const state = part.state as Record<string, unknown> | undefined;
        if (part.tool === "write" && state) {
          const meta = state.metadata as Record<string, unknown> | undefined;
          if (meta && typeof meta.filepath === "string") {
            changedFiles.add(meta.filepath);
          }
        }
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
