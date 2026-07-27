import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseSliceManifestFromText,
  planSliceManifest,
  type SliceManifest
} from "../../../src/compose/slices.js";
import { slicePlanningPrompt } from "../../../src/core/prompt.js";
import type { StreamingRunResult } from "../../../src/mimo/streaming-runner.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeProject(files: Record<string, string> = {}): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-slice-plan-"));
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

function jsonLine(text: string): string {
  return JSON.stringify({ type: "text", text, sessionID: "sess-1" });
}

function makeRunResult(finalText: string, exitCode = 0): StreamingRunResult {
  return {
    stdout: `${jsonLine(finalText)}\n`,
    stderr: "",
    exitCode,
    pid: 123
  };
}

describe("parseSliceManifestFromText", () => {
  it("parses a bare JSON SliceManifest envelope", () => {
    const manifest = baseManifest({ slices: [baseManifest().slices[0]] });
    const parsed = parseSliceManifestFromText(JSON.stringify(manifest));

    expect(parsed).toEqual(manifest);
  });

  it("parses a fenced JSON SliceManifest envelope", () => {
    const manifest = baseManifest();
    const parsed = parseSliceManifestFromText([
      "Planning complete.",
      "```json",
      JSON.stringify(manifest),
      "```"
    ].join("\n"));

    expect(parsed).toEqual(manifest);
  });

  it("returns null for malformed manifest JSON", () => {
    expect(parseSliceManifestFromText("not json")).toBeNull();
    expect(parseSliceManifestFromText(JSON.stringify({ version: 2, slices: [] }))).toBeNull();
    expect(parseSliceManifestFromText(JSON.stringify({ version: 1 }))).toBeNull();
    expect(parseSliceManifestFromText(JSON.stringify({ slices: [] }))).toBeNull();
  });
});

describe("slicePlanningPrompt", () => {
  it("requires a JSON SliceManifest envelope and read-only planning rules", () => {
    const prompt = slicePlanningPrompt("Implement callback wiring");

    expect(prompt).toMatch(/^Objective:/);
    expect(prompt).toContain("Implement callback wiring");
    expect(prompt).toContain('"version": 1');
    expect(prompt).toContain('"slices"');
    expect(prompt).toContain("Do not edit files.");
    expect(prompt).toContain("SliceManifest envelope");
  });
});

describe("planSliceManifest", () => {
  it("materializes a single-slice manifest without calling MiMo", async () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } })
    });
    const runMimo = vi.fn();

    const result = await planSliceManifest({
      cwd,
      chainId: "chain-root",
      objective: "Implement callback wiring",
      batchMode: "single",
      repositoryFingerprint: "fp-root",
      acceptance: validAcceptance(),
      runMimo
    });

    expect(runMimo).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected valid manifest");
    }
    expect(result.manifest).toMatchObject({
      version: 1,
      chainId: "chain-root",
      objective: "Implement callback wiring",
      repositoryFingerprint: "fp-root",
      slices: [{ id: "slice-1", objective: "Implement callback wiring" }]
    });
  });

  it("runs a read-only plan agent for auto mode and validates the parsed manifest", async () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } })
    });
    const manifest = baseManifest({ slices: [baseManifest().slices[0]] });
    const runMimo = vi.fn(async () => makeRunResult(JSON.stringify(manifest)));

    const result = await planSliceManifest({
      cwd,
      chainId: "chain-root",
      objective: manifest.objective,
      batchMode: "auto",
      repositoryFingerprint: manifest.repositoryFingerprint,
      runMimo
    });

    expect(runMimo).toHaveBeenCalledOnce();
    const args = runMimo.mock.calls[0][1] as string[];
    expect(args).toContain("--agent");
    expect(args).toContain("plan");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected valid manifest");
    }
    expect(result.manifest.slices).toHaveLength(1);
  });

  it("requires at least two slices in sliced mode", async () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } })
    });
    const manifest = baseManifest({ slices: [baseManifest().slices[0]] });
    const runMimo = vi.fn(async () => makeRunResult(JSON.stringify(manifest)));

    const result = await planSliceManifest({
      cwd,
      chainId: "chain-root",
      objective: manifest.objective,
      batchMode: "sliced",
      repositoryFingerprint: manifest.repositoryFingerprint,
      runMimo
    });

    expect(result).toEqual({
      ok: false,
      code: "slice_plan_invalid",
      reason: "Slice manifest must contain between 2 and 8 slices."
    });
  });

  it("returns slice_plan_invalid when the planner output lacks a manifest envelope", async () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } })
    });
    const runMimo = vi.fn(async () => makeRunResult("Planning notes only."));

    const result = await planSliceManifest({
      cwd,
      chainId: "chain-root",
      objective: "Implement callback wiring",
      batchMode: "auto",
      repositoryFingerprint: "fp-root",
      runMimo
    });

    expect(result).toEqual({
      ok: false,
      code: "slice_plan_invalid",
      reason: "Slice planning must end with a valid JSON SliceManifest envelope."
    });
  });

  it("returns slice_plan_invalid when the planner process exits non-zero", async () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } })
    });
    const runMimo = vi.fn(async () => makeRunResult("", 1));

    const result = await planSliceManifest({
      cwd,
      chainId: "chain-root",
      objective: "Implement callback wiring",
      batchMode: "auto",
      repositoryFingerprint: "fp-root",
      runMimo
    });

    expect(result).toEqual({
      ok: false,
      code: "slice_plan_invalid",
      reason: "Slice planning MiMo process exited with code 1"
    });
  });
});
