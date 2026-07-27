import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  preflightVerificationCommand,
  resolveVerificationCommand,
  type ResolvedVerificationCommand
} from "../../../src/compose/command-resolution.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempCwd(files: Record<string, string> = {}): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-cmd-res-"));
  tempDirs.push(cwd);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(cwd, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return cwd;
}

describe("command-resolution (baseline regressions)", () => {
  it("prefers mvnw.cmd on Windows when present", () => {
    const cwd = tempCwd({ "mvnw.cmd": "@echo off\n", "pom.xml": "<project/>" });
    const resolved = resolveVerificationCommand({
      cwd,
      command: "mvn -q package -DskipTests",
      platform: "win32",
      source: "detected"
    });
    expect(resolved).toMatchObject({
      requestedCommand: "mvn -q package -DskipTests",
      resolution: "maven_wrapper",
      file: expect.stringMatching(/mvnw\.cmd$/i)
    } satisfies Partial<ResolvedVerificationCommand>);
  });

  it("prefers ./mvnw on POSIX when present", () => {
    const cwd = tempCwd({ mvnw: "#!/bin/sh\n", "pom.xml": "<project/>" });
    const resolved = resolveVerificationCommand({
      cwd,
      command: "mvn test",
      platform: "linux",
      source: "detected"
    });
    expect(resolved.resolution).toBe("maven_wrapper");
    expect(resolved.executedCommand).toMatch(/mvnw/);
  });

  it("does not rewrite explicit absolute maven paths", () => {
    const cwd = tempCwd({ "mvnw.cmd": "@echo off\n" });
    const absolute = path.join(cwd, "custom-mvn.cmd");
    fs.writeFileSync(absolute, "@echo off\n", "utf8");
    const resolved = resolveVerificationCommand({
      cwd,
      command: `"${absolute}" test`,
      platform: "win32",
      source: "explicit"
    });
    expect(resolved.resolution).toBe("unchanged");
  });

  it("preflight fails with acceptance_command_unavailable when maven is missing", async () => {
    const cwd = tempCwd({ "pom.xml": "<project/>" });
    const result = await preflightVerificationCommand({
      cwd,
      command: "mvn test",
      platform: "win32",
      pathLookup: async () => undefined
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("acceptance_command_unavailable");
  });
});
