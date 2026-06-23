import { describe, expect, it, vi } from "vitest";
import { buildWorkerArgs, terminateJobProcess } from "../../src/core/job-process.js";

describe("job process", () => {
  it("builds compose worker args", () => {
    expect(buildWorkerArgs("compose", "job-1")).toEqual(["compose-worker", "--job-id", "job-1"]);
  });

  it("terminates finite pids through injected killer", () => {
    const kill = vi.fn();
    terminateJobProcess(123, { killProcess: kill });
    expect(kill).toHaveBeenCalledWith(123);
  });

  it("ignores missing pids", () => {
    const kill = vi.fn();
    terminateJobProcess(null, { killProcess: kill });
    expect(kill).not.toHaveBeenCalled();
  });
});
