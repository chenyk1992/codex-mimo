import { describe, expect, it } from "vitest";
import { parseChangedFiles } from "../../src/git/diff.js";

describe("git diff helpers", () => {
  it("parses changed files from git diff --name-only output", () => {
    expect(parseChangedFiles("src/a.ts\nREADME.md\n\n")).toEqual(["src/a.ts", "README.md"]);
  });

  it("returns an empty list for blank output", () => {
    expect(parseChangedFiles("\n")).toEqual([]);
  });
});
