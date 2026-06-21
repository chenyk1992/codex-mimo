import { describe, expect, it } from "vitest";
import { normalizeVerificationCommands } from "../../src/compose/verify.js";

describe("verification command normalization", () => {
  it("uses explicit commands when provided", () => {
    expect(normalizeVerificationCommands(["npm test", "npm run build"], ["npm test"])).toEqual([
      "npm test",
      "npm run build"
    ]);
  });

  it("falls back to workflow defaults", () => {
    expect(normalizeVerificationCommands(undefined, ["npm test"])).toEqual(["npm test"]);
  });
});
