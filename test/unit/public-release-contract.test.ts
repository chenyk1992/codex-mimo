import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("public release contract", () => {
  it("describes the six queued work tools and seven control or diagnostic tools", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(".codex-plugin/plugin.json"), "utf8")
    ) as { interface?: { longDescription?: string }; keywords?: string[] };

    expect(manifest.interface?.longDescription).toMatch(/six queued work tools/i);
    expect(manifest.interface?.longDescription).toMatch(/seven control(?: and|\/)diagnostic tools/i);
    expect(manifest.keywords ?? []).not.toContain("acp");
  });

  it("documents the complete CLI exit-code contract", () => {
    for (const file of ["README.md", "doc/operations-guide.md"]) {
      const contents = fs.readFileSync(path.resolve(file), "utf8");
      expect(contents).toMatch(/exit codes?[\s\S]{0,160}`?0`?[^\n]*success/i);
      expect(contents).toMatch(/`?2`?[^\n]*(?:command|input|schema)/i);
      expect(contents).toMatch(/`?1`?[^\n]*runtime[^\n]*(?:doctor|healthcheck)/i);
    }
  });

  it("publishes at-least-once Codex delivery across crashes in user and release documents", () => {
    for (const file of [
      "README.md",
      "doc/operations-guide.md",
      "docs/superpowers/specs/2026-07-16-background-job-notification-design.md",
      "docs/superpowers/plans/2026-07-18-unified-background-jobs-release-closure.md"
    ]) {
      const contents = fs.readFileSync(path.resolve(file), "utf8");
      expect(contents).toMatch(/at-least-once/i);
      expect(contents).toMatch(/normal(?: operation|-path)[\s\S]{0,180}(?:one|single)[^\n]*(?:turn\/start|delivery)/i);
    }
  });
});
