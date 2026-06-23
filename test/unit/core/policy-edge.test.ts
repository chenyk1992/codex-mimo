import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideCommand,
  decideFileRead,
  decideFileWrite,
  defaultPolicy
} from "../../../src/core/policy.js";

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-policy-edge-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("policy edge cases", () => {
  it("5.1: read workspace file → allow", () => {
    const cwd = tempWorkspace();
    const policy = defaultPolicy(cwd);
    const filePath = path.join(cwd, "src", "index.ts");
    expect(decideFileRead(policy, filePath)).toBe("allow");
  });

  it("5.2: read outside workspace → deny", () => {
    const cwd = tempWorkspace();
    const policy = defaultPolicy(cwd);
    expect(decideFileRead(policy, "/tmp/outside/file.ts")).toBe("deny");
  });

  it("5.3: read .env variants → deny", () => {
    const cwd = tempWorkspace();
    const policy = defaultPolicy(cwd);
    expect(decideFileRead(policy, path.join(cwd, ".env"))).toBe("deny");
    expect(decideFileRead(policy, path.join(cwd, ".env.local"))).toBe("deny");
    expect(decideFileRead(policy, path.join(cwd, ".env.production"))).toBe("deny");
  });

  it("5.4: write .npmrc → deny", () => {
    const cwd = tempWorkspace();
    const policy = defaultPolicy(cwd);
    expect(decideFileWrite(policy, path.join(cwd, ".npmrc"))).toBe("deny");
  });

  it("5.5: command git push → deny", () => {
    const cwd = tempWorkspace();
    const policy = defaultPolicy(cwd);
    expect(decideCommand(policy, "git push origin main")).toBe("deny");
  });

  it("5.6: command npm test → allow", () => {
    const cwd = tempWorkspace();
    const policy = defaultPolicy(cwd);
    expect(decideCommand(policy, "npm test")).toBe("allow");
  });

  it("5.7: command npm install → ask", () => {
    const cwd = tempWorkspace();
    const policy = defaultPolicy(cwd);
    expect(decideCommand(policy, "npm install")).toBe("ask");
  });

  it("5.8: CI mode ask → deny", () => {
    const cwd = tempWorkspace();
    const policy = { ...defaultPolicy(cwd), ciMode: true };
    expect(decideCommand(policy, "npm install")).toBe("deny");
  });
});
