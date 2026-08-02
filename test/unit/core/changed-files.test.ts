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
      artifactFiles: [],
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
      artifactFiles: [],
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
      artifactFiles: [],
      candidates: [],
      status: "complete",
      sources: ["git_fingerprint"]
    });
  });

  it("does not attribute a pre-existing tracked HEAD diff to the active job", () => {
    expect(detectChangedFiles({
      cwd: "E:/repo",
      gitStatusBefore: {
        short: " M existing.md",
        dirty: true,
        fingerprints: {
          "existing.md": { status: " M", contentHash: "same-content" }
        }
      },
      gitStatusAfter: {
        short: " M existing.md\n?? src/new.ts",
        dirty: true,
        fingerprints: {
          "existing.md": { status: " M", contentHash: "same-content" },
          "src/new.ts": { status: "??", contentHash: "new-content" }
        }
      },
      diff: {
        changedFiles: ["existing.md", "src/new.ts"],
        diffStat: " existing.md | 1 +",
        diff: "diff --git a/existing.md b/existing.md"
      }
    })).toEqual({
      files: ["src/new.ts"],
      artifactFiles: [],
      candidates: [],
      status: "complete",
      sources: ["git_fingerprint", "git_diff"]
    });
  });

  it("falls back to the HEAD diff when Git status baselines are unavailable", () => {
    expect(detectChangedFiles({
      cwd: "E:/repo",
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
      diff: {
        changedFiles: ["src/fallback.ts"],
        diffStat: "",
        diff: ""
      }
    })).toMatchObject({
      files: ["src/fallback.ts"],
      artifactFiles: [],
      sources: ["git_diff"],
      status: "partial"
    });
  });

  it("separates declared build outputs from source changes without losing either", () => {
    const result = detectChangedFiles({
      cwd: "E:/repo",
      gitStatusBefore: { short: "", dirty: false, fingerprints: {} },
      gitStatusAfter: {
        short: "?? src/app.ts\n?? out/classes/App.class",
        dirty: true,
        fingerprints: {
          "src/app.ts": { status: "??", contentHash: "source" },
          "out/classes/App.class": { status: "??", contentHash: "artifact" }
        }
      },
      artifactPaths: ["out/**"],
      toolUsePaths: ["src/app.ts", "out/classes/App.class"]
    });

    expect(result.files).toEqual(["src/app.ts"]);
    expect(result.artifactFiles).toEqual(["out/classes/App.class"]);
    expect(result.candidates).toEqual([]);
  });

  it("retains only declared artifacts when no business files changed", () => {
    const result = detectChangedFiles({
      cwd: "E:/repo",
      gitStatusBefore: { short: "", dirty: false, fingerprints: {} },
      gitStatusAfter: {
        short: "?? build/classes/App.class",
        dirty: true,
        fingerprints: {
          "build/classes/App.class": { status: "??", contentHash: "artifact" }
        }
      },
      artifactPaths: ["build/**"]
    });

    expect(result.files).toEqual([]);
    expect(result.artifactFiles).toEqual(["build/classes/App.class"]);
    expect(result.status).toBe("complete");
  });

  it("does not classify ordinary source files as artifacts without a matching declaration", () => {
    const result = detectChangedFiles({
      cwd: "E:/repo",
      gitStatusBefore: { short: "", dirty: false, fingerprints: {} },
      gitStatusAfter: {
        short: "?? src/generated.ts",
        dirty: true,
        fingerprints: {
          "src/generated.ts": { status: "??", contentHash: "source" }
        }
      },
      artifactPaths: ["build/**"]
    });

    expect(result.files).toEqual(["src/generated.ts"]);
    expect(result.artifactFiles).toEqual([]);
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
