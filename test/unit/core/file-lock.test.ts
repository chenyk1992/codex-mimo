import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFileLock } from "../../../src/core/file-lock.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempLock(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-lock-"));
  tempDirs.push(dir);
  return path.join(dir, "job.state.lock");
}

describe("file lock", () => {
  it("reclaims an abandoned lock owned by a dead process", () => {
    const file = tempLock();
    fs.writeFileSync(file, JSON.stringify({ pid: 2_147_483_647, createdAt: 0 }), "utf8");

    expect(withFileLock(file, () => "recovered", { timeoutMs: 100, retryMs: 5 }))
      .toBe("recovered");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("removes a newly-created lock when owner metadata cannot be written", () => {
    const file = tempLock();
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("metadata write failed");
    });

    expect(() => withFileLock(file, () => undefined)).toThrow("metadata write failed");
    expect(fs.existsSync(file)).toBe(false);
  });
});
