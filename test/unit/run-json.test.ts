import { describe, expect, it } from "vitest";
import { buildMimoRunArgs } from "../../src/mimo/run-json.js";

describe("buildMimoRunArgs", () => {
  it("builds a basic plan command with message before flags", () => {
    expect(
      buildMimoRunArgs({
        cwd: "E:/project/app",
        message: "Plan the login change",
        agent: "plan"
      })
    ).toEqual(["run", "--format", "json", "Plan the login change", "--agent", "plan"]);
  });

  it("places message before --file to avoid file path interpretation", () => {
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
      "Fix CI",
      "--agent",
      "build",
      "--model",
      "mimo/mimo-v2.5-pro",
      "--session",
      "sess_123",
      "--fork",
      "--file",
      "ci.log"
    ]);
  });

  it("builds compose run args with message before all flags", () => {
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
      "Use @compose",
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
      "ci.log"
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
      "Continue task",
      "--agent",
      "compose",
      "--continue"
    ]);
  });
});
