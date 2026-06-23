import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendJobEventLine,
  appendJobLogLine,
  readRecentJobLogLines
} from "../../src/core/job-log.js";

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-job-log-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const cwd of tempDirs.splice(0)) {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

describe("job log", () => {
  it("appends timestamped log lines and reads recent messages without timestamps", () => {
    const logFile = path.join(tempWorkspace(), "logs", "job.log");

    appendJobLogLine(logFile, "Starting job.");
    appendJobLogLine(logFile, "Running npm test.");

    const content = fs.readFileSync(logFile, "utf8");
    expect(content).toMatch(/^\[[^\]]+\] Starting job\.\r?\n\[[^\]]+\] Running npm test\.\r?\n$/);
    expect(readRecentJobLogLines(logFile, 1)).toEqual(["Running npm test."]);
  });

  it("appends raw event lines while preserving non-empty JSONL content", () => {
    const eventsFile = path.join(tempWorkspace(), "events", "job.jsonl");

    appendJobEventLine(eventsFile, '{"type":"message","text":"hello"}\n');
    appendJobEventLine(eventsFile, '{"type":"message","text":"space"}   \n');
    appendJobEventLine(eventsFile, "not json");
    appendJobEventLine(eventsFile, "   \n");

    expect(fs.readFileSync(eventsFile, "utf8")).toBe(
      '{"type":"message","text":"hello"}\n{"type":"message","text":"space"}   \nnot json\n'
    );
  });

  it("returns no recent lines when the log file does not exist", () => {
    const logFile = path.join(tempWorkspace(), "missing", "job.log");

    expect(readRecentJobLogLines(logFile)).toEqual([]);
  });
});
