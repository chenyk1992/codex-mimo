import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ATTENTION_SIGNAL_KINDS,
  appendJobSignal,
  isAttentionSignal,
  readJobSignals
} from "../../src/core/job-signals.js";

function tempSignalFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-signals-")), "signals.jsonl");
}

describe("job signals", () => {
  it("appends compact signals and reads them by cursor", () => {
    const file = tempSignalFile();

    appendJobSignal(file, {
      jobId: "job-1",
      kind: "phase_changed",
      level: "info",
      phase: "starting",
      summary: "Starting."
    });
    appendJobSignal(file, {
      jobId: "job-1",
      kind: "milestone",
      level: "info",
      phase: "investigating",
      summary: "Read source files."
    });

    const first = readJobSignals(file);
    expect(first.nextCursor).toBe(2);
    expect(first.signals.map((signal) => signal.cursor)).toEqual([1, 2]);
    expect(first.signals[0]).toMatchObject({
      jobId: "job-1",
      kind: "phase_changed",
      summary: "MiMoCode entered the starting phase."
    });

    const second = readJobSignals(file, { sinceCursor: 1 });
    expect(second.nextCursor).toBe(2);
    expect(second.signals.map((signal) => signal.cursor)).toEqual([2]);
  });

  it("filters by level and limit without reading invalid lines as signals", () => {
    const file = tempSignalFile();
    fs.writeFileSync(file, "not-json\n", "utf8");
    appendJobSignal(file, {
      jobId: "job-1",
      kind: "milestone",
      level: "debug",
      summary: "Noisy."
    });
    appendJobSignal(file, {
      jobId: "job-1",
      kind: "failed",
      level: "error",
      summary: "Failed."
    });

    const result = readJobSignals(file, { minLevel: "info", limit: 1 });
    expect(result.nextCursor).toBe(2);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({
      cursor: 2,
      kind: "failed",
      level: "error"
    });
  });

  it("returns an empty cursor result when the signal file is missing", () => {
    const result = readJobSignals(path.join(os.tmpdir(), "missing-codex-mimo-signals.jsonl"));
    expect(result).toEqual({ signals: [], nextCursor: 0 });
  });

  it("identifies only attention-worthy signal kinds", () => {
    expect(ATTENTION_SIGNAL_KINDS).toEqual([
      "needs_input",
      "blocked",
      "completed",
      "failed",
      "cancelled",
      "timeout"
    ]);
    expect(ATTENTION_SIGNAL_KINDS.every(isAttentionSignal)).toBe(true);
    expect(isAttentionSignal("phase_changed")).toBe(false);
    expect(isAttentionSignal({ kind: "milestone" })).toBe(false);
  });
});
