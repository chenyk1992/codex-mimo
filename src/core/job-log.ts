import fs from "node:fs";
import path from "node:path";

export function appendJobLogLine(logFile: string, message: string): void {
  const trimmed = message.trim();
  if (!trimmed) return;

  ensureParentDir(logFile);
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${trimmed}\n`, "utf8");
}

export function appendJobEventLine(eventsFile: string, line: string): void {
  const trimmed = line.trimEnd();
  if (!trimmed) return;

  ensureParentDir(eventsFile);
  fs.appendFileSync(eventsFile, `${trimmed}\n`, "utf8");
}

export function readRecentJobLogLines(logFile: string, count = 5): string[] {
  if (!fs.existsSync(logFile)) return [];

  return fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-count)
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, "").trim());
}

function ensureParentDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}
