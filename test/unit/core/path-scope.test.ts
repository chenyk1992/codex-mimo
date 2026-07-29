import { describe, expect, it } from "vitest";
import {
  allowedPathPatternsOverlap,
  findOutOfScopePaths,
  isPathWithinAllowedScope,
  mergeAllowedPathScopes,
  normalizeRepositoryPath,
  validateAllowedPathPattern
} from "../../../src/core/path-scope.js";

describe("path-scope (baseline regressions)", () => {
  it("normalizes Windows separators to repository paths", () => {
    expect(normalizeRepositoryPath("src\\a.ts")).toBe("src/a.ts");
  });

  it("accepts exact files, directories, and trailing /**", () => {
    expect(validateAllowedPathPattern("src/app.ts")).toBeNull();
    expect(validateAllowedPathPattern("src/components")).toBeNull();
    expect(validateAllowedPathPattern("src/components/**")).toBeNull();
  });

  it("rejects bare **, ., empty, absolute, .., UNC, and unsupported globs", () => {
    for (const pattern of ["**", ".", "", "/etc/passwd", "../outside", "\\\\server\\share", "src/*.ts", "src/?/a.ts"]) {
      expect(validateAllowedPathPattern(pattern), pattern).not.toBeNull();
    }
  });

  it("matches src/** to src/a.ts but not test/a.ts", () => {
    expect(isPathWithinAllowedScope("src/a.ts", ["src/**"])).toBe(true);
    expect(isPathWithinAllowedScope("test/a.ts", ["src/**"])).toBe(false);
  });

  it("finds out-of-scope paths", () => {
    expect(findOutOfScopePaths(["src/a.ts", "docs/x.md"], ["src/**"])).toEqual(["docs/x.md"]);
  });

  it("detects overlapping source and artifact scopes", () => {
    expect(allowedPathPatternsOverlap("src/**", "src/app.ts")).toBe(true);
    expect(allowedPathPatternsOverlap("out/**", "src/app.ts")).toBe(false);
  });

  it("merges source and artifact scopes without duplicates", () => {
    expect(mergeAllowedPathScopes(["src/app.ts"], ["out/**", "src/app.ts"]))
      .toEqual(["src/app.ts", "out/**"]);
    expect(mergeAllowedPathScopes(undefined, [])).toBeUndefined();
  });
});
