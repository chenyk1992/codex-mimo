import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFinalJobOutput } from "../../../src/core/job-output.js";

const tempDirs: string[] = [];

function tempFile(contents?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-job-output-"));
  tempDirs.push(dir);
  const file = path.join(dir, "events.jsonl");
  if (contents !== undefined) fs.writeFileSync(file, contents, "utf8");
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("readFinalJobOutput", () => {
  it("reads top-level text events", () => {
    const file = tempFile(`${JSON.stringify({ type: "text", text: "first" })}\n`);
    expect(readFinalJobOutput(file)).toBe("first");
  });

  it("reads nested MiMo part.text events", () => {
    const file = tempFile(`${JSON.stringify({ type: "text", part: { text: "final plan" } })}\n`);
    expect(readFinalJobOutput(file)).toBe("final plan");
  });

  it("returns the last non-empty message", () => {
    const file = tempFile([
      JSON.stringify({ type: "text", text: "first" }),
      JSON.stringify({ type: "text", text: "   " }),
      JSON.stringify({ type: "text", part: { text: "final plan" } })
    ].join("\n"));
    expect(readFinalJobOutput(file)).toBe("final plan");
  });

  it("trims trailing whitespace but preserves internal Markdown and newlines", () => {
    const body = "# Plan\n\nBody with **bold**\nand a list:\n- one\n- two";
    const file = tempFile(`${JSON.stringify({ type: "text", part: { text: `${body}\n\n  ` } })}\n`);
    expect(readFinalJobOutput(file)).toBe(body);
  });

  it("ignores malformed JSONL lines when a later valid message exists", () => {
    const file = tempFile([
      "{not-json",
      JSON.stringify({ type: "text", text: "kept" }),
      "also broken"
    ].join("\n"));
    expect(readFinalJobOutput(file)).toBe("kept");
  });

  it("returns undefined for a missing file", () => {
    expect(readFinalJobOutput(path.join(os.tmpdir(), "codex-mimo-missing-events.jsonl"))).toBeUndefined();
  });

  it("returns undefined for an empty file", () => {
    expect(readFinalJobOutput(tempFile(""))).toBeUndefined();
  });

  it("returns undefined when the path is unreadable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-job-output-dir-"));
    tempDirs.push(dir);
    expect(readFinalJobOutput(dir)).toBeUndefined();
  });
});
