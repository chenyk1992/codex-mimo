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
    [".mimocode/.cron-lock", true],
    ["./.mimocode/.cron-lock", true],
    [".mimocode\\.cron-lock", true],
    [".mimocode/mimocode.jsonc", false],
    [".mimocode/agents/reviewer.md", false],
    [".mimocode/.cron-lock.bak", false],
    ["src/.mimocode/.cron-lock", false]
  ])("classifies %s as %s", (file, expected) => {
    expect(isRuntimeArtifactPath(file)).toBe(expected);
  });

  it("normalizes Windows separators and one leading ./", () => {
    expect(normalizeWorkspacePath("./.mimocode\\.cron-lock"))
      .toBe(".mimocode/.cron-lock");
  });
});
