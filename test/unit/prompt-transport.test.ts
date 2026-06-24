import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preparePromptTransport } from "../../src/mimo/prompt-transport.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("prompt transport", () => {
  it("keeps short ASCII prompts inline", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-transport-"));
    tempDirs.push(cwd);
    const result = preparePromptTransport("Fix the bug in auth.ts", { cwd });
    expect(result.message).toBe("Fix the bug in auth.ts");
    expect(result.files).toEqual([]);
  });

  it("moves long prompts into a UTF-8 file", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-transport-"));
    tempDirs.push(cwd);
    const longTask = "x".repeat(9000);
    const result = preparePromptTransport(longTask, { cwd });
    expect(result.message).toContain("Objective is stored in UTF-8 prompt file");
    expect(result.files).toHaveLength(1);
    expect(fs.readFileSync(result.files[0], "utf-8")).toBe(longTask);
  });

  it("moves non-ASCII prompts into a UTF-8 file", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-transport-"));
    tempDirs.push(cwd);
    const chineseTask = "基于附件生成计划";
    const result = preparePromptTransport(chineseTask, { cwd });
    expect(result.message).toContain("Objective is stored in UTF-8 prompt file");
    expect(result.files).toHaveLength(1);
    expect(fs.readFileSync(result.files[0], "utf-8")).toBe(chineseTask);
  });

  it("respects forceFile option", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-transport-"));
    tempDirs.push(cwd);
    const result = preparePromptTransport("short", { cwd, forceFile: true });
    expect(result.message).toContain("Objective is stored in UTF-8 prompt file");
    expect(result.files).toHaveLength(1);
  });
});
