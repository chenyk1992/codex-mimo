import { describe, expect, it } from "vitest";
import { buildMimoRunArgs } from "../../src/mimo/run-json.js";

describe("buildMimoRunArgs", () => {
  it("builds a basic plan command", () => {
    expect(
      buildMimoRunArgs({
        cwd: "E:/project/app",
        message: "Plan the login change",
        agent: "plan"
      })
    ).toEqual(["run", "--format", "json", "--agent", "plan", "Plan the login change"]);
  });

  it("includes session, fork, model, and files", () => {
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
      "Fix CI"
    ]);
  });
});
