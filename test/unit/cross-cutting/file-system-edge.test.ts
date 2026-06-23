import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizePath, isPathInside } from "../../../src/core/paths.js";
import { createJobStore, resolveJobDir } from "../../../src/core/job-store.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-xcut-fs-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("file system edge cases", () => {
  it(".codex-mimo directory auto-creation on job store create", () => {
    const cwd = tempWorkspace();
    const jobDir = resolveJobDir(cwd);

    expect(fs.existsSync(jobDir)).toBe(false);

    createJobStore(cwd).create({ kind: "compose", workflow: "dev", task: "Init", request: {} });

    expect(fs.existsSync(jobDir)).toBe(true);
  });

  it("paths with spaces are handled correctly", () => {
    const cwd = tempWorkspace();
    const spacedDir = path.join(cwd, "my project (v2)");
    fs.mkdirSync(spacedDir, { recursive: true });

    const normalized = normalizePath(spacedDir);
    expect(normalized).toContain("my project (v2)");
    expect(normalized).not.toContain("\\");

    expect(isPathInside(cwd, spacedDir)).toBe(true);
  });

  it("paths with special characters are handled correctly", () => {
    const cwd = tempWorkspace();
    const specialDir = path.join(cwd, "project[1] & stuff");
    fs.mkdirSync(specialDir, { recursive: true });

    const normalized = normalizePath(specialDir);
    expect(normalized).toContain("project[1] & stuff");
    expect(isPathInside(cwd, specialDir)).toBe(true);
  });

  it("Windows long paths are normalized correctly", () => {
    const longSegment = "a".repeat(100);
    const longPath = `E:/project/${longSegment}/${longSegment}/${longSegment}`;

    const normalized = normalizePath(longPath);
    expect(normalized).toContain(longSegment);
    expect(isPathInside("E:/project", normalized)).toBe(true);
  });

  it("nested .codex-mimo directories created for deeply nested workspaces", () => {
    const cwd = tempWorkspace();
    const deepDir = path.join(cwd, "packages", "app", "src");
    fs.mkdirSync(deepDir, { recursive: true });

    createJobStore(deepDir).create({ kind: "compose", workflow: "dev", task: "Deep", request: {} });

    expect(fs.existsSync(resolveJobDir(deepDir))).toBe(true);
  });
});
