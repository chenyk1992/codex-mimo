import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { buildWorkerArgs, buildWorkerProcessLaunch, terminateJobProcess } from "../../src/core/job-process.js";

describe("job process", () => {
  it("builds compose worker args", () => {
    expect(buildWorkerArgs("compose", "job-1")).toEqual(["compose-worker", "--job-id", "job-1"]);
  });

  it("launches workers from the plugin root and passes project cwd explicitly", () => {
    const launch = buildWorkerProcessLaunch(
      "E:/ideaProjects/lex-vault",
      "compose",
      "job-1",
      "file:///C:/Users/Administrator/.codex/plugins/cache/personal/codex-mimocode/0.1.0/dist/core/job-process.js"
    );

    expect(path.isAbsolute(launch.entryPoint)).toBe(true);
    expect(launch.entryPoint.replace(/\\/g, "/")).toBe(
      "C:/Users/Administrator/.codex/plugins/cache/personal/codex-mimocode/0.1.0/dist/cli/main.js"
    );
    expect(launch.cwd.replace(/\\/g, "/")).toBe(
      "C:/Users/Administrator/.codex/plugins/cache/personal/codex-mimocode/0.1.0"
    );
    expect(launch.args).toEqual([
      launch.entryPoint,
      "compose-worker",
      "--job-id",
      "job-1",
      "--cwd",
      "E:/ideaProjects/lex-vault"
    ]);
  });

  it("terminates finite pids through injected killer", () => {
    const kill = vi.fn();
    terminateJobProcess(123, { killProcess: kill });
    expect(kill).toHaveBeenCalledWith(123);
  });

  it("terminates process trees on Windows by default", () => {
    const spawnSync = vi.fn();
    terminateJobProcess(123, { platform: "win32", spawnSync });
    expect(spawnSync).toHaveBeenCalledWith("taskkill", ["/PID", "123", "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
  });

  it("terminates process groups on POSIX by default", () => {
    const killProcess = vi.fn();
    terminateJobProcess(123, { platform: "linux", killProcess });
    expect(killProcess).toHaveBeenCalledWith(-123);
  });

  it("ignores missing pids", () => {
    const kill = vi.fn();
    terminateJobProcess(null, { killProcess: kill });
    expect(kill).not.toHaveBeenCalled();
  });
});
