import { describe, expect, it } from "vitest";
import {
  isRuntimeArtifactPath,
  normalizeWorkspacePath
} from "../../../src/core/runtime-paths.js";

describe("runtime artifact paths", () => {
  it.each([
    [".codex-mimo", true],
    [".codex-mimo/jobs/job.json", true],
    ["./.codex-mimo/jobs/job.json", true],
    [".mimocode", true],
    [".mimocode/.cron-lock", true],
    ["./.mimocode/.cron-lock", true],
    [".mimocode\\.cron-lock", true],
    [".mimocode/mimocode.jsonc", true],
    [".mimocode/agents/reviewer.md", true],
    [".mimocode/plans/1784884130128-happy-circuit.md", true],
    [".mimocode/.cron-lock.bak", true],
    ["src/.mimocode/.cron-lock", false],
    ["src/.mimocode/plans/x.md", false],
    ["src/app.ts", false]
  ])("classifies %s as %s", (file, expected) => {
    expect(isRuntimeArtifactPath(file)).toBe(expected);
  });

  it("normalizes Windows separators and one leading ./", () => {
    expect(normalizeWorkspacePath("./.mimocode\\.cron-lock"))
      .toBe(".mimocode/.cron-lock");
  });
});
