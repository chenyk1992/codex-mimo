import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  INSTALLED_PLUGIN_ROOT_ENV,
  resolveInstalledPluginRoot,
  withoutCodexPathCandidates
} from "../smoke/local-codex-notification-support.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function makePlugin(version: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-mimo-installed-plugin-"));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
  writeFileSync(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "codex-mimocode",
    version
  }));
  writeFileSync(path.join(root, ".mcp.json"), "{}\n");
  return root;
}

describe("local Codex notification smoke configuration", () => {
  it("requires an explicit installed plugin root", () => {
    expect(() => resolveInstalledPluginRoot("C:\\checkout", {})).toThrow(
      `${INSTALLED_PLUGIN_ROOT_ENV} must point to the installed codex-mimocode plugin package.`
    );
  });

  it("rejects the source checkout as the installed plugin root", () => {
    const checkout = makePlugin("1.0.0");

    expect(() => resolveInstalledPluginRoot(checkout, {
      [INSTALLED_PLUGIN_ROOT_ENV]: checkout
    })).toThrow("must not point to the source checkout");
  });

  it("rejects an installed package with a stale manifest version", () => {
    const checkout = makePlugin("2.0.0");
    const installed = makePlugin("1.0.0");

    expect(() => resolveInstalledPluginRoot(checkout, {
      [INSTALLED_PLUGIN_ROOT_ENV]: installed
    })).toThrow("Installed codex-mimocode plugin version 1.0.0 does not match checkout version 2.0.0.");
  });

  it("returns a distinct installed package with the current manifest version", () => {
    const checkout = makePlugin("2.0.0");
    const installed = makePlugin("2.0.0");

    expect(resolveInstalledPluginRoot(checkout, {
      [INSTALLED_PLUGIN_ROOT_ENV]: installed
    })).toBe(path.resolve(installed));
  });

  it("removes every PATH directory that exposes a Codex command", () => {
    const clean = mkdtempSync(path.join(os.tmpdir(), "codex-mimo-clean-path-"));
    const codexExe = mkdtempSync(path.join(os.tmpdir(), "codex-mimo-codex-exe-path-"));
    const codexCmd = mkdtempSync(path.join(os.tmpdir(), "codex-mimo-codex-cmd-path-"));
    temporaryRoots.push(clean, codexExe, codexCmd);
    writeFileSync(path.join(codexExe, "codex.exe"), "");
    writeFileSync(path.join(codexCmd, "codex.CMD"), "");

    const result = withoutCodexPathCandidates({
      Path: [codexExe, clean, codexCmd].join(path.delimiter),
      PATHEXT: ".EXE;.CMD",
      CODEX_MIMO_CODEX_BIN: "C:\\configured\\codex.exe",
      KEEP_ME: "yes"
    });

    expect(result).toMatchObject({
      PATH: clean,
      PATHEXT: ".EXE;.CMD",
      KEEP_ME: "yes"
    });
    expect(result.Path).toBeUndefined();
    expect(result.CODEX_MIMO_CODEX_BIN).toBeUndefined();
  });
});
