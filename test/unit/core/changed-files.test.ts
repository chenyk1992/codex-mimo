import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  captureScopedWorkspaceManifest,
  detectChangedFiles,
  fingerprintWorkspaceFiles
} from "../../../src/core/changed-files.js";

const roots: string[] = [];

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-changes-"));
  roots.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("multi-source changed file detection", () => {
  it("uses scoped fingerprints for ignored or non-git output", () => {
    const cwd = workspace();
    fs.mkdirSync(path.join(cwd, "generated"), { recursive: true });
    const before = captureScopedWorkspaceManifest(cwd, ["generated/**"])!;
    fs.writeFileSync(path.join(cwd, "generated", "client.ts"), "export const x = 1;\n");
    const after = captureScopedWorkspaceManifest(cwd, ["generated/**"])!;

    expect(detectChangedFiles({
      cwd,
      gitStatusBefore: {
        short: "",
        dirty: false,
        fingerprints: {},
        repositoryAvailable: false
      },
      gitStatusAfter: {
        short: "",
        dirty: false,
        fingerprints: {},
        repositoryAvailable: false
      },
      manifestBefore: before,
      manifestAfter: after,
      toolUsePaths: ["generated/client.ts"]
    })).toEqual({
      files: ["generated/client.ts"],
      candidates: [],
      status: "complete",
      sources: ["scope_manifest"]
    });
  });

  it("marks tool paths partial when no reliable baseline exists", () => {
    const cwd = workspace();
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "app.ts"), "export {};\n");

    expect(detectChangedFiles({
      cwd,
      gitStatusBefore: {
        short: "",
        dirty: false,
        fingerprints: {},
        repositoryAvailable: false
      },
      gitStatusAfter: {
        short: "",
        dirty: false,
        fingerprints: {},
        repositoryAvailable: false
      },
      toolUsePaths: ["src/app.ts"]
    })).toMatchObject({
      files: [],
      candidates: ["src/app.ts"],
      status: "partial",
      sources: []
    });
  });

  it("reports complete Git evidence even when there are no changes", () => {
    expect(detectChangedFiles({
      cwd: "E:/repo",
      gitStatusBefore: { short: "", dirty: false, fingerprints: {} },
      gitStatusAfter: { short: "", dirty: false, fingerprints: {} },
      toolUsePaths: []
    })).toEqual({
      files: [],
      candidates: [],
      status: "complete",
      sources: ["git_fingerprint"]
    });
  });

  it("fingerprints current workspace file content deterministically", () => {
    const cwd = workspace();
    fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
    const first = fingerprintWorkspaceFiles(cwd, ["a.txt"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "two\n");
    const second = fingerprintWorkspaceFiles(cwd, ["a.txt"]);
    expect(first).not.toBe(second);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
  });
});
