import { describe, expect, it } from "vitest";
import { buildMimoRunArgs } from "../../src/mimo/run-json.js";

describe("buildMimoRunArgs", () => {
  it("builds a basic plan command with flags before a separated message", () => {
    expect(
      buildMimoRunArgs({
        cwd: "E:/project/app",
        message: "Plan the login change",
        agent: "plan"
      })
    ).toEqual(["run", "--format", "json", "--agent", "plan", "--", "Plan the login change"]);
  });

  it("separates files from the message so --file cannot consume the prompt", () => {
    expect(
      buildMimoRunArgs({
        cwd: "E:/project/app",
        message: "Fix CI",
        agent: "build",
        model: "mimo/mimo-v2.5-pro",
        session: "sess_123",
        fork: true,
        files: ["ci.log"]
      })
    ).toEqual([
      "run",
      "--format",
      "json",
      "--agent",
      "build",
      "--model",
      "mimo/mimo-v2.5-pro",
      "--session",
      "sess_123",
      "--fork",
      "--file",
      "ci.log",
      "--",
      "Fix CI"
    ]);
  });

  it("builds compose run args with a separated message", () => {
    expect(
      buildMimoRunArgs({
        cwd: "E:/project/app",
        message: "Use @compose",
        agent: "compose",
        title: "codex-mimo compose dev",
        session: "sess_123",
        fork: true,
        attach: "http://localhost:4096",
        files: ["ci.log"]
      })
    ).toEqual([
      "run",
      "--format",
      "json",
      "--agent",
      "compose",
      "--session",
      "sess_123",
      "--fork",
      "--title",
      "codex-mimo compose dev",
      "--attach",
      "http://localhost:4096",
      "--file",
      "ci.log",
      "--",
      "Use @compose"
    ]);
  });

  it("includes --continue flag when set", () => {
    expect(
      buildMimoRunArgs({
        cwd: "E:/project/app",
        message: "Continue task",
        agent: "compose",
        continue: true
      })
    ).toEqual([
      "run",
      "--format",
      "json",
      "--agent",
      "compose",
      "--continue",
      "--",
      "Continue task"
    ]);
  });
});
