import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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

  const file = writePromptAttachment(message, { cwd: options.cwd, label: "prompt", extension: ".md" });

  return {
    message: [
      `Objective is stored in UTF-8 prompt file: @${file}`,
      "Read that file as the full task input before acting.",
      `On Windows PowerShell, use \`Get-Content -Encoding UTF8 "${file}"\` rather than omitting the encoding flag.`
    ].join("\n"),
    files: [file],
    cleanupFiles: []
  };
}

export function writePromptAttachment(
  content: string,
  options: { cwd: string; label: string; extension: string }
): string {
  const dir = path.join(options.cwd, ".codex-mimo", "inputs");
  const label = options.label.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+|-+$/g, "") || "input";
  const extension = options.extension.startsWith(".") ? options.extension : `.${options.extension}`;
  const unique = crypto.randomBytes(4).toString("hex");
  const file = path.join(
    dir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${unique}-${label}${extension}`
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

function hasNonAscii(value: string): boolean {
  return /[^\u0000-\u007f]/.test(value);
}
