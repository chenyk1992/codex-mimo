import { describe, expect, it } from "vitest";
import { planPrompt, implementPrompt, reviewPrompt } from "../../../src/core/prompt.js";

describe("prompt builders", () => {
  it("5.13: planPrompt starts with Objective:", () => {
    const prompt = planPrompt("Add auth middleware");
    expect(prompt.startsWith("Objective:")).toBe(true);
    expect(prompt).toContain("Add auth middleware");
  });

  it("5.14: implementPrompt includes Do not ask", () => {
    const prompt = implementPrompt("Implement login");
    expect(prompt).toContain("Do not ask");
  });

  it("5.15: reviewPrompt starts with Objective: and includes diff summary", () => {
    const diffSummary = "diff --git a/src/index.ts b/src/index.ts\n+console.log('hello');";
    const prompt = reviewPrompt(diffSummary);
    expect(prompt.startsWith("Objective:")).toBe(true);
    expect(prompt).toContain(diffSummary);
    expect(prompt).toContain("Do not ask");
  });
});
