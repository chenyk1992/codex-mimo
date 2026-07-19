import { describe, expect, it, vi } from "vitest";

import { normalizeVerificationCommands, runVerificationCommands } from "../../src/compose/verify.js";

describe("verification command normalization", () => {
  it("uses explicit commands when provided", () => {
    expect(normalizeVerificationCommands(["npm test", "npm run build"], ["npm test"])).toEqual([
      "npm test",
      "npm run build"
    ]);
  });

  it("falls back to workflow defaults", () => {
    expect(normalizeVerificationCommands(undefined, ["npm test"])).toEqual(["npm test"]);
  });
});

describe("verification cancellation", () => {
  it("passes the authoritative signal to execa and rejects cancellation", async () => {
    const controller = new AbortController();
    const execute = vi.fn((
      _file: string,
      _args: string[],
      options: { cancelSignal?: AbortSignal }
    ) => new Promise<{ exitCode: number; stdout: string; stderr: string }>((_resolve, reject) => {
      options.cancelSignal?.addEventListener(
        "abort",
        () => reject(new Error("cancelled")),
        { once: true }
      );
    }));

    const verification = runVerificationCommands("E:/project", ["node -e process.exit(0)"], {
      signal: controller.signal,
      execute
    });
    controller.abort(new Error("job cancelled"));

    await expect(verification).rejects.toThrow("job cancelled");
    const callOptions = execute.mock.calls[0]?.find(
      (value) => typeof value === "object" && value !== null && "cancelSignal" in value
    );
    expect(callOptions?.cancelSignal).toBe(controller.signal);
  });
});
