import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeDevelopmentAcceptancePlan } from "../../../src/compose/acceptance.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeProject(files: Record<string, string>): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-acceptance-"));
  tempDirs.push(cwd);
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(cwd, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }
  return cwd;
}

describe("normalizeDevelopmentAcceptancePlan", () => {
  it("prefers package.json build script for the build stage", () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({
        scripts: { build: "tsc", test: "vitest run" }
      })
    });

    const plan = normalizeDevelopmentAcceptancePlan({
      cwd,
      requireAcceptance: true
    });

    expect(plan).toMatchObject({
      source: "detected",
      stages: [
        {
          stage: "build",
          commands: ["npm run build"],
          required: true
        },
        {
          stage: "test",
          commands: ["npm test"],
          required: true
        },
        {
          stage: "diff_check",
          commands: [],
          required: true
        }
      ]
    });
  });

  it("maps legacy verification to the test stage only", () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ scripts: { build: "tsc" } })
    });

    const plan = normalizeDevelopmentAcceptancePlan({
      cwd,
      legacyVerification: ["npm test -- focused.test.ts"],
      requireAcceptance: true
    });

    expect(plan).toMatchObject({
      source: "mixed"
    });
    if ("stages" in plan) {
      expect(plan.stages[0]).toMatchObject({
        stage: "build",
        commands: ["npm run build"],
        required: true
      });
      expect(plan.stages[1]).toMatchObject({
        stage: "test",
        commands: ["npm test -- focused.test.ts"],
        required: true
      });
      expect(plan.stages[1]?.commands).not.toContain("npm run build");
    }
  });

  it("returns acceptance_config_missing when requireAcceptance and test is empty", () => {
    const cwd = makeProject({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } })
    });

    const plan = normalizeDevelopmentAcceptancePlan({
      cwd,
      requireAcceptance: true
    });

    expect(plan).toEqual({
      missing: true,
      code: "acceptance_config_missing",
      reason: expect.stringContaining("test")
    });
  });

  it("marks build not applicable for a pytest-only tree", () => {
    const cwd = makeProject({
      "pyproject.toml": "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n"
    });

    const plan = normalizeDevelopmentAcceptancePlan({
      cwd,
      requireAcceptance: true
    });

    expect(plan).toMatchObject({
      source: "detected",
      stages: [
        {
          stage: "build",
          commands: [],
          notApplicableReason: "non_compiled_or_no_build_tooling",
          required: false
        },
        {
          stage: "test",
          commands: ["python -m pytest"],
          required: true
        },
        {
          stage: "diff_check",
          commands: [],
          required: true
        }
      ]
    });
  });

  it("uses explicit acceptance commands when provided", () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ scripts: { build: "tsc" } })
    });

    const plan = normalizeDevelopmentAcceptancePlan({
      cwd,
      acceptance: {
        build: ["npm run compile"],
        test: ["npm test -- unit.test.ts"]
      },
      requireAcceptance: true
    });

    expect(plan).toMatchObject({
      source: "explicit",
      stages: [
        { stage: "build", commands: ["npm run compile"], required: true },
        { stage: "test", commands: ["npm test -- unit.test.ts"], required: true },
        { stage: "diff_check", commands: [], required: true }
      ]
    });
  });

  it("detects tsc when tsconfig exists without a build script", () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } })
    });

    const plan = normalizeDevelopmentAcceptancePlan({
      cwd,
      requireAcceptance: true
    });

    if ("stages" in plan) {
      expect(plan.stages[0]).toMatchObject({
        stage: "build",
        commands: ["tsc -p tsconfig.json --noEmit"],
        required: true
      });
    } else {
      throw new Error("expected plan");
    }
  });

  it("omits diff_check when acceptance.diffCheck is false", () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } })
    });

    const plan = normalizeDevelopmentAcceptancePlan({
      cwd,
      acceptance: { diffCheck: false, test: ["npm test"] },
      requireAcceptance: true
    });

    if ("stages" in plan) {
      expect(plan.stages.map((stage) => stage.stage)).toEqual(["build", "test"]);
    } else {
      throw new Error("expected plan");
    }
  });

  it("allows empty test when requireAcceptance is false", () => {
    const cwd = makeProject({});

    const plan = normalizeDevelopmentAcceptancePlan({
      cwd,
      requireAcceptance: false
    });

    if ("stages" in plan) {
      expect(plan.stages.find((stage) => stage.stage === "test")).toMatchObject({
        commands: [],
        required: false
      });
    } else {
      throw new Error("expected plan");
    }
  });
});
