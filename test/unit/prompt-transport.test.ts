import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createImmutablePromptAttachment,
  preparePromptTransport,
  remapPromptTransportToWorkspace,
  verifyImmutablePromptAttachments
} from "../../src/mimo/prompt-transport.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("prompt transport", () => {
  it("keeps short ASCII prompts inline", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-transport-"));
    tempDirs.push(cwd);
    const result = preparePromptTransport("Fix the bug in auth.ts", { cwd });
    expect(result).toEqual({ message: "Fix the bug in auth.ts", files: [] });
  });

  it("moves long prompts into a UTF-8 file", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-transport-"));
    tempDirs.push(cwd);
    const longTask = "x".repeat(9000);
    const result = preparePromptTransport(longTask, { cwd });
    expect(result.message).toMatch(/^Read the full UTF-8 task from @\.codex-mimo\/inputs\/.+\.md before acting\.$/);
    expect(result.message).not.toMatch(/[\r\n]/);
    expect(result.files).toHaveLength(1);
    expect(fs.readFileSync(result.files[0], "utf-8")).toBe(longTask);
  });

  it("moves non-ASCII prompts into a UTF-8 file", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-transport-"));
    tempDirs.push(cwd);
    const chineseTask = "基于附件生成计划";
    const result = preparePromptTransport(chineseTask, { cwd });
    expect(result.message).toMatch(/^Read the full UTF-8 task from @\.codex-mimo\/inputs\/.+\.md before acting\.$/);
    expect(result.message).not.toMatch(/[\r\n]/);
    expect(result.message).not.toContain(cwd);
    expect(result.files).toHaveLength(1);
    expect(fs.readFileSync(result.files[0], "utf-8")).toBe(chineseTask);
  });

  it("respects forceFile option", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-transport-"));
    tempDirs.push(cwd);
    const result = preparePromptTransport("short", { cwd, forceFile: true });
    expect(result.message).toContain("Read the full UTF-8 task from @.codex-mimo/inputs/");
    expect(result.files).toHaveLength(1);
  });

  it("moves short multi-line ASCII prompts into a file with a single-line pointer", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-transport-"));
    tempDirs.push(cwd);
    const prompt = "First line\nSecond line";

    const result = preparePromptTransport(prompt, { cwd });

    expect(result.message).not.toMatch(/[\r\n]/);
    expect(result.files).toHaveLength(1);
    expect(fs.readFileSync(result.files[0], "utf-8")).toBe(prompt);
  });

  it("verifies immutable review attachments while accepting legacy transport results", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-transport-"));
    tempDirs.push(cwd);
    const diff = path.join(cwd, "review.diff");
    fs.writeFileSync(diff, "diff --git a/a b/a\n", "utf8");
    const attachment = createImmutablePromptAttachment(diff, { base: "HEAD", head: "abc123" });

    expect(verifyImmutablePromptAttachments({ immutableAttachments: [attachment] })).toEqual({ ok: true });
    expect(verifyImmutablePromptAttachments({})).toEqual({ ok: true });

    fs.writeFileSync(diff, "tampered\n", "utf8");
    expect(verifyImmutablePromptAttachments({ immutableAttachments: [attachment] })).toMatchObject({
      ok: false,
      path: diff,
      expectedSha256: attachment.sha256
    });
  });

  it("copies a long prompt into the execution workspace without mutating the control prompt", () => {
    const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-control-"));
    const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-execution-"));
    tempDirs.push(controlRoot, executionRoot);
    const original = preparePromptTransport("x".repeat(9000), { cwd: controlRoot });

    const remapped = remapPromptTransportToWorkspace(original, { controlRoot, executionRoot });

    expect(remapped).not.toBe(original);
    expect(remapped.files).toHaveLength(1);
    expect(remapped.files[0]!.startsWith(path.join(executionRoot, ".codex-mimo", "inputs"))).toBe(true);
    expect(remapped.message).toMatch(/@\.codex-mimo\/inputs\//);
    expect(remapped.message).not.toContain(controlRoot);
    expect(fs.readFileSync(remapped.files[0]!, "utf8")).toHaveLength(9000);
    expect(original.files[0]!.startsWith(controlRoot)).toBe(true);
    expect(original.message).toContain("@.codex-mimo/inputs/");
  });

  it("remaps immutable review diffs and references embedded in the transported prompt", () => {
    const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-control-"));
    const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-execution-"));
    tempDirs.push(controlRoot, executionRoot);
    const diff = path.join(controlRoot, "review.diff");
    fs.writeFileSync(diff, "diff --git a/a b/a\n", "utf8");
    const immutable = createImmutablePromptAttachment(diff, { base: "HEAD~1", head: "deadbeef" });
    const original = preparePromptTransport(
      `Review only @${diff}. This is an intentionally multi-line prompt.\nDo not use other diffs.`,
      { cwd: controlRoot }
    );
    original.files.push(diff);
    original.immutableAttachments = [immutable];

    const remapped = remapPromptTransportToWorkspace(original, { controlRoot, executionRoot });
    const remappedDiff = remapped.immutableAttachments![0]!;
    const copiedPrompt = remapped.files.find((file) => path.extname(file) === ".md")!;

    expect(remappedDiff).toMatchObject({ base: "HEAD~1", head: "deadbeef", sha256: immutable.sha256 });
    expect(remappedDiff.path.startsWith(path.join(executionRoot, ".codex-mimo", "inputs"))).toBe(true);
    expect(verifyImmutablePromptAttachments(remapped)).toEqual({ ok: true });
    expect(fs.readFileSync(copiedPrompt, "utf8")).toContain(`@${path.relative(executionRoot, remappedDiff.path).split(path.sep).join("/")}`);
    expect(fs.readFileSync(copiedPrompt, "utf8")).not.toContain(diff);
    expect(original.immutableAttachments![0]!.path).toBe(diff);
  });

  it("copies an explicit external CI log and avoids same-name attachment collisions", () => {
    const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-control-"));
    const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-execution-"));
    const externalOne = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-external-one-"));
    const externalTwo = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-external-two-"));
    tempDirs.push(controlRoot, executionRoot, externalOne, externalTwo);
    const logOne = path.join(externalOne, "ci.log");
    const logTwo = path.join(externalTwo, "ci.log");
    fs.writeFileSync(logOne, "first failure", "utf8");
    fs.writeFileSync(logTwo, "second failure", "utf8");
    const original = { message: `Use @${logOne} and @${logTwo}.`, files: [logOne, logTwo] };

    const remapped = remapPromptTransportToWorkspace(original, { controlRoot, executionRoot });

    expect(remapped.files).toHaveLength(2);
    expect(remapped.files[0]).not.toBe(remapped.files[1]);
    expect(fs.readFileSync(remapped.files[0]!, "utf8")).toBe("first failure");
    expect(fs.readFileSync(remapped.files[1]!, "utf8")).toBe("second failure");
    expect(remapped.message).not.toContain(externalOne);
    expect(remapped.message).not.toContain(externalTwo);
  });

  it("rejects an immutable attachment that was changed before copying", () => {
    const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-control-"));
    const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-execution-"));
    tempDirs.push(controlRoot, executionRoot);
    const diff = path.join(controlRoot, "review.diff");
    fs.writeFileSync(diff, "original", "utf8");
    const immutable = createImmutablePromptAttachment(diff);
    fs.writeFileSync(diff, "tampered", "utf8");

    expect(() => remapPromptTransportToWorkspace({
      message: `Review @${diff}.`,
      files: [diff],
      immutableAttachments: [immutable]
    }, { controlRoot, executionRoot })).toThrow(/changed before execution/i);
  });
});
