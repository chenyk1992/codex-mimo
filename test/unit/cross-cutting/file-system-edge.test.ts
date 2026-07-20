import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("nested .codex-mimo directories created for deeply nested workspaces", () => {
    const cwd = tempWorkspace();
    const deepDir = path.join(cwd, "packages", "app", "src");
    fs.mkdirSync(deepDir, { recursive: true });

    createJobStore(deepDir).create({ kind: "compose", workflow: "dev", task: "Deep", request: {} });

    expect(fs.existsSync(resolveJobDir(deepDir))).toBe(true);
  });
});
