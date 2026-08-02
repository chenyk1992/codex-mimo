import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureWorkspaceManifest,
  prepareExecutionWorkspace
} from "../../../src/core/execution-workspace.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe("execution-workspace", () => {
  it("captures and copies dirty, untracked, ignored and binary files without copying runtime metadata", () => {
    const sourceRoot = temporaryDirectory("source-");
    fs.mkdirSync(path.join(sourceRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, ".codex-mimo", "jobs"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "src", "dirty.ts"), "dirty change\n");
    fs.writeFileSync(path.join(sourceRoot, "untracked.txt"), "untracked\n");
    fs.writeFileSync(path.join(sourceRoot, "ignored.log"), "normally ignored\n");
    fs.writeFileSync(path.join(sourceRoot, "asset.bin"), Buffer.from([0, 255, 17, 99]));
    fs.writeFileSync(path.join(sourceRoot, ".git", "HEAD"), "not copied");
    fs.writeFileSync(path.join(sourceRoot, ".codex-mimo", "jobs", "state.json"), "not copied");

    const manifest = captureWorkspaceManifest(sourceRoot);
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "asset.bin",
      "ignored.log",
      "src",
      "src/dirty.ts",
      "untracked.txt"
    ]);

    const executionRoot = path.join(temporaryDirectory("execution-parent-"), "workspace");
    const prepared = prepareExecutionWorkspace({ sourceRoot, executionRoot });
    expect(prepared.baseline.entries).toEqual(manifest.entries);
    expect(fs.readFileSync(path.join(executionRoot, "asset.bin"))).toEqual(Buffer.from([0, 255, 17, 99]));
    expect(fs.readFileSync(path.join(executionRoot, "ignored.log"), "utf8")).toBe("normally ignored\n");
    expect(fs.existsSync(path.join(executionRoot, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(executionRoot, ".codex-mimo", "jobs"))).toBe(false);
    expect(fs.existsSync(prepared.ownerMetadataPath)).toBe(true);
  });

  it("fails closed when the manifest would exceed its entry limit", () => {
    const sourceRoot = temporaryDirectory("source-");
    fs.writeFileSync(path.join(sourceRoot, "one.txt"), "one");
    fs.writeFileSync(path.join(sourceRoot, "two.txt"), "two");

    expect(() => captureWorkspaceManifest(sourceRoot, { maxEntries: 1 }))
      .toThrow("Workspace manifest exceeds maximum entry count");
  });

  it("rejects a junction or symlink that resolves outside the source workspace", () => {
    const sourceRoot = temporaryDirectory("source-");
    const outsideRoot = temporaryDirectory("outside-");
    fs.writeFileSync(path.join(outsideRoot, "secret.txt"), "outside");
    fs.symlinkSync(outsideRoot, path.join(sourceRoot, "outside-link"), "junction");

    const executionRoot = path.join(temporaryDirectory("execution-parent-"), "workspace");
    expect(() => prepareExecutionWorkspace({ sourceRoot, executionRoot }))
      .toThrow("Workspace symlink escapes source root: outside-link");
    expect(fs.existsSync(executionRoot)).toBe(false);
  });

  it("rewrites an internal absolute directory link to the isolated workspace", () => {
    const sourceRoot = temporaryDirectory("source-");
    const linkedDirectory = path.join(sourceRoot, "linked");
    fs.mkdirSync(linkedDirectory);
    fs.writeFileSync(path.join(linkedDirectory, "value.txt"), "source value\n");
    const sourceLink = path.join(sourceRoot, "absolute-link");
    fs.symlinkSync(linkedDirectory, sourceLink, process.platform === "win32" ? "junction" : "dir");

    const executionRoot = path.join(temporaryDirectory("execution-parent-"), "workspace");
    prepareExecutionWorkspace({ sourceRoot, executionRoot });
    const copiedLink = path.join(executionRoot, "absolute-link");
    const copiedTarget = fs.realpathSync(copiedLink);
    expect(isInside(executionRoot, copiedTarget)).toBe(true);
    expect(isInside(sourceRoot, copiedTarget)).toBe(false);

    fs.writeFileSync(path.join(copiedLink, "value.txt"), "execution value\n");
    expect(fs.readFileSync(path.join(sourceRoot, "linked", "value.txt"), "utf8")).toBe("source value\n");
    expect(fs.readFileSync(path.join(executionRoot, "linked", "value.txt"), "utf8")).toBe("execution value\n");
  });
});

function temporaryDirectory(prefix: string): string {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `codex-mimo-${prefix}`));
  temporaryRoots.push(temporaryRoot);
  return temporaryRoot;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
