import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runComposeWorkflow } from "../../../src/compose/runner.js";

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-xcut-err-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("error propagation", () => {
  it("ENOENT from mimo CLI produces meaningful error in report", async () => {
    const cwd = tempWorkspace();
    const enoent = new Error("spawn mimo ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";

    const result = await runComposeWorkflow(
      { cwd, workflow: "dev", task: "Test ENOENT", reportDir: path.join(cwd, "reports") },
      {
        runMimo: async () => { throw enoent; },
        writeReport: () => undefined,
        now: () => new Date("2026-06-24T00:00:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MiMoCode execution failed");
    expect(result.error).toContain("ENOENT");
  });

  it("timeout produces exitCode 124 and status timeout", async () => {
    const cwd = tempWorkspace();

    const result = await runComposeWorkflow(
      { cwd, workflow: "dev", task: "Test timeout", reportDir: path.join(cwd, "reports") },
      {
        runMimo: async () => ({
          stdout: "",
          stderr: "",
          exitCode: 124
        }),
        captureDiff: async () => ({ changedFiles: [], diffStat: "", diff: "" }),
        captureStatus: async () => ({ short: "", dirty: false }),
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-24T00:00:00.000Z")
      }
    );

    expect(result.status).toBe("timeout");
  });

  it("disk full (writeFileSync fails) error is not swallowed", async () => {
    const cwd = tempWorkspace();

    const result = await runComposeWorkflow(
      { cwd, workflow: "dev", task: "Test disk full", reportDir: path.join(cwd, "reports") },
      {
        runMimo: async () => ({
          stdout: '{"type":"message","text":"done"}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => {
          const diskFull = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
          diskFull.code = "ENOSPC";
          throw diskFull;
        },
        captureStatus: async () => ({ short: "", dirty: false }),
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-24T00:00:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Git diff capture failed");
    expect(result.error).toContain("ENOSPC");
  });

  it("network interruption error propagates through runner", async () => {
    const cwd = tempWorkspace();

    const result = await runComposeWorkflow(
      { cwd, workflow: "dev", task: "Test network", reportDir: path.join(cwd, "reports") },
      {
        runMimo: async () => {
          throw new Error("ECONNRESET: socket hang up");
        },
        writeReport: () => undefined,
        now: () => new Date("2026-06-24T00:00:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MiMoCode execution failed");
    expect(result.error).toContain("ECONNRESET");
  });
});
