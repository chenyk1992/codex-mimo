import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface PromptTransportResult {
  message: string;
  files: string[];
}

export function preparePromptTransport(
  message: string,
  options: { cwd: string; forceFile?: boolean; maxInlineLength?: number }
): PromptTransportResult {
  const maxInlineLength = options.maxInlineLength ?? 8_000;
  const shouldUseFile = Boolean(options.forceFile) ||
    message.length > maxInlineLength ||
    hasNonAscii(message) ||
    hasLineBreak(message);
  if (!shouldUseFile) {
    return { message, files: [] };
  }

  const file = writePromptAttachment(message, { cwd: options.cwd, label: "prompt", extension: ".md" });

  return {
    message: `Read the full UTF-8 task from @${promptFileReference(options.cwd, file)} before acting.`,
    files: [file]
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

function hasLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

function promptFileReference(cwd: string, file: string): string {
  return path.relative(cwd, file).split(path.sep).join("/");
}
