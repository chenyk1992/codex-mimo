import fs from "node:fs";
import path from "node:path";

export interface PromptTransportResult {
  message: string;
  files: string[];
  cleanupFiles: string[];
}

export function preparePromptTransport(
  message: string,
  options: { cwd: string; forceFile?: boolean; maxInlineLength?: number }
): PromptTransportResult {
  const maxInlineLength = options.maxInlineLength ?? 8_000;
  const shouldUseFile = Boolean(options.forceFile) || message.length > maxInlineLength || hasNonAscii(message);
  if (!shouldUseFile) {
    return { message, files: [], cleanupFiles: [] };
  }

  const dir = path.join(options.cwd, ".codex-mimo", "inputs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-prompt.md`);
  fs.writeFileSync(file, message, "utf-8");

  return {
    message: `Objective is stored in UTF-8 prompt file: @${file}\nRead that file as the full task input before acting.`,
    files: [file],
    cleanupFiles: []
  };
}

function hasNonAscii(value: string): boolean {
  return /[^\u0000-\u007f]/.test(value);
}
