import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  isRepositoryRelativePath,
  materializeSingleSliceManifest,
  validateSliceManifest,
  type SliceManifest
} from "../../../src/compose/slices.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeProject(files: Record<string, string> = {}): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-slices-"));
  tempDirs.push(cwd);
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(cwd, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }
  return cwd;
}

function validAcceptance() {
  return {
    build: ["npm run build"],
    test: ["npm test -- slice.test.ts"]
  };
}

function baseManifest(overrides: Partial<SliceManifest> = {}): SliceManifest {
  return {
    version: 1,
    chainId: "chain-root",
    objective: "Implement slice chain validation",
    repositoryFingerprint: "fp-abc123",
    slices: [
      {
        id: "slice-a",
        title: "Add schema",
        objective: "Add the schema module only",
        dependsOn: [],
        contextFiles: ["src/schema.ts"],
        allowedPaths: ["src/schema.ts"],
        acceptance: validAcceptance()
      },
      {
        id: "slice-b",
        title: "Add tests",
        objective: "Add focused tests for schema",
        dependsOn: ["slice-a"],
        contextFiles: ["test/schema.test.ts"],
        allowedPaths: ["test/schema.test.ts"],
        acceptance: validAcceptance()
      }
    ],
    ...overrides
  };
}

describe("validateSliceManifest", () => {
  it("accepts a valid two-slice manifest", () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } })
    });

    const result = validateSliceManifest(baseManifest(), { cwd });

    expect(result).toEqual({
      ok: true,
      manifest: baseManifest()
    });
  });

  it("rejects cyclic dependencies", () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } })
    });
    const manifest = baseManifest({
      slices: [
        {
          id: "slice-a",
          title: "A",
          objective: "Do A",
          dependsOn: ["slice-b"],
          contextFiles: [],
          allowedPaths: ["src/a.ts"],
          acceptance: validAcceptance()
        },
        {
          id: "slice-b",
          title: "B",
          objective: "Do B",
          dependsOn: ["slice-a"],
          contextFiles: [],
          allowedPaths: ["src/b.ts"],
          acceptance: validAcceptance()
        }
      ]
    });

    const result = validateSliceManifest(manifest, { cwd });

    expect(result).toEqual({
      ok: false,
      code: "slice_plan_invalid",
      reason: "Slice dependencies must be acyclic."
    });
  });

  it("rejects missing acceptance test commands", () => {
    const cwd = makeProject({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } })
    });
    const manifest = baseManifest({
      slices: [
        {
          id: "slice-a",
          title: "A",
          objective: "Do A",
          dependsOn: [],
          contextFiles: [],
          allowedPaths: ["src/a.ts"],
          acceptance: { build: ["npm run build"] }
        }
      ]
    });

    const result = validateSliceManifest(manifest, { cwd });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected invalid manifest");
    }
    expect(result.code).toBe("slice_plan_invalid");
    expect(result.reason).toMatch(/test/i);
  });

  it("rejects more than eight slices", () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } })
    });
    const slices = Array.from({ length: 9 }, (_, index) => ({
      id: `slice-${index + 1}`,
      title: `Slice ${index + 1}`,
      objective: `Objective ${index + 1}`,
      dependsOn: index === 0 ? [] : [`slice-${index}`],
      contextFiles: [],
      allowedPaths: [`src/s${index + 1}.ts`],
      acceptance: validAcceptance()
    }));

    const result = validateSliceManifest(baseManifest({ slices }), { cwd });

    expect(result).toEqual({
      ok: false,
      code: "slice_plan_invalid",
      reason: "Slice manifest must contain between 1 and 8 slices."
    });
  });

  it("rejects unknown dependency ids", () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } })
    });
    const manifest = baseManifest({
      slices: [
        {
          id: "slice-a",
          title: "A",
          objective: "Do A",
          dependsOn: ["missing-slice"],
          contextFiles: [],
          allowedPaths: ["src/a.ts"],
          acceptance: validAcceptance()
        }
      ]
    });

    const result = validateSliceManifest(manifest, { cwd });

    expect(result).toEqual({
      ok: false,
      code: "slice_plan_invalid",
      reason: 'Slice "slice-a" depends on unknown slice "missing-slice".'
    });
  });

  it("rejects absolute allowedPaths", () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } })
    });
    const manifest = baseManifest({
      slices: [
        {
          id: "slice-a",
          title: "A",
          objective: "Do A",
          dependsOn: [],
          contextFiles: [],
          allowedPaths: ["/etc/passwd"],
          acceptance: validAcceptance()
        }
      ]
    });

    const result = validateSliceManifest(manifest, { cwd });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected invalid manifest");
    }
    expect(result.code).toBe("slice_plan_invalid");
    expect(result.reason).toMatch(/allowedPaths/);
  });

  it("rejects .. traversal in contextFiles", () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } })
    });
    const manifest = baseManifest({
      slices: [
        {
          id: "slice-a",
          title: "A",
          objective: "Do A",
          dependsOn: [],
          contextFiles: ["../secrets.env"],
          allowedPaths: ["src/a.ts"],
          acceptance: validAcceptance()
        }
      ]
    });

    const result = validateSliceManifest(manifest, { cwd });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected invalid manifest");
    }
    expect(result.reason).toMatch(/contextFiles/);
  });

  it("enforces minSlices when sliced mode requires at least two slices", () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } })
    });
    const manifest = baseManifest({
      slices: [
        {
          id: "slice-a",
          title: "A",
          objective: "Do A",
          dependsOn: [],
          contextFiles: [],
          allowedPaths: ["src/a.ts"],
          acceptance: validAcceptance()
        }
      ]
    });

    const result = validateSliceManifest(manifest, { cwd, minSlices: 2 });

    expect(result).toEqual({
      ok: false,
      code: "slice_plan_invalid",
      reason: "Slice manifest must contain between 2 and 8 slices."
    });
  });
});

describe("materializeSingleSliceManifest", () => {
  it("creates a one-slice manifest from the root request", () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } })
    });

    const manifest = materializeSingleSliceManifest({
      chainId: "chain-root",
      objective: "Implement callback wiring",
      repositoryFingerprint: "fp-root",
      acceptance: validAcceptance(),
      allowedPaths: ["src/callback.ts"],
      contextFiles: ["src/callback.ts"]
    });

    expect(manifest).toMatchObject({
      version: 1,
      chainId: "chain-root",
      objective: "Implement callback wiring",
      repositoryFingerprint: "fp-root",
      slices: [
        {
          id: "slice-1",
          title: "Implement callback wiring",
          objective: "Implement callback wiring",
          dependsOn: [],
          contextFiles: ["src/callback.ts"],
          allowedPaths: ["src/callback.ts"],
          acceptance: validAcceptance()
        }
      ]
    });

    const validation = validateSliceManifest(manifest, { cwd });
    expect(validation.ok).toBe(true);
  });

  it("rejects single mode without bounded allowedPaths and rejects bare **", () => {
    expect(() =>
      materializeSingleSliceManifest({
        chainId: "chain-root",
        objective: "Unbounded write",
        repositoryFingerprint: "fp-root",
        acceptance: validAcceptance()
      })
    ).toThrow(/bounded allowedPaths|requires bounded allowedPaths/i);

    expect(() =>
      materializeSingleSliceManifest({
        chainId: "chain-root",
        objective: "Unbounded write",
        repositoryFingerprint: "fp-root",
        acceptance: validAcceptance(),
        allowedPaths: ["**"]
      })
    ).toThrow(/\*\*|repository-wide/i);
  });
});

describe("isRepositoryRelativePath", () => {
  it("accepts normal repository-relative paths", () => {
    expect(isRepositoryRelativePath("src/a.ts")).toBe(true);
    expect(isRepositoryRelativePath("test/unit/**/*.test.ts")).toBe(true);
  });

  it("rejects absolute and traversal paths", () => {
    expect(isRepositoryRelativePath("/etc/passwd")).toBe(false);
    expect(isRepositoryRelativePath("C:\\Windows\\System32")).toBe(false);
    expect(isRepositoryRelativePath("../outside.ts")).toBe(false);
    expect(isRepositoryRelativePath("src/../../outside.ts")).toBe(false);
  });
});
