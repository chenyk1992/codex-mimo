import { describe, expect, it } from "vitest";
import { normalizePath, isPathInside } from "../../src/core/paths.js";

describe("normalizePath", () => {
  it("converts backslashes to forward slashes", () => {
    const result = normalizePath("E:\\project\\app\\src");
    expect(result).not.toContain("\\");
    expect(result).toContain("/");
  });

  it("resolves to absolute path", () => {
    const result = normalizePath("relative/path");
    expect(result).toMatch(/^([A-Z]:|\/)/);
  });
});

describe("isPathInside", () => {
  it("returns true for child path", () => {
    expect(isPathInside("E:/project/app", "E:/project/app/src/index.ts")).toBe(true);
  });

  it("returns true for exact match", () => {
    expect(isPathInside("E:/project/app", "E:/project/app")).toBe(true);
  });

  it("returns false for sibling path", () => {
    expect(isPathInside("E:/project/app", "E:/other/app/src")).toBe(false);
  });

  it("returns false for prefix-only match", () => {
    expect(isPathInside("E:/project/app", "E:/project/app2/src")).toBe(false);
  });
});
