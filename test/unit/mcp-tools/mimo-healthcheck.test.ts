import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execa: vi.fn()
}));

vi.mock("execa", () => ({ execa: mocks.execa }));

import { mimoHealthcheck } from "../../../src/codex/tools.js";

describe("mimo_healthcheck", () => {
  beforeEach(() => {
    mocks.execa.mockReset();
  });

  it("returns version on success", async () => {
    mocks.execa.mockResolvedValue({ stdout: "mimo 0.5.0\n", stderr: "" });
    const result = await mimoHealthcheck({ cwd: "/tmp/proj" });
    expect(result).toEqual({ ok: true, version: "mimo 0.5.0", cwd: "/tmp/proj" });
    expect(mocks.execa).toHaveBeenCalledWith("mimo", ["--version"], { cwd: "/tmp/proj" });
  });

  it("returns error when mimo is not installed", async () => {
    mocks.execa.mockRejectedValue(new Error("ENOENT"));
    const result = await mimoHealthcheck({ cwd: "/tmp/proj" });
    expect(result).toEqual({ ok: false, error: "mimo not found or not working", cwd: "/tmp/proj" });
  });

  it("defaults cwd to process.cwd()", async () => {
    mocks.execa.mockResolvedValue({ stdout: "mimo 0.5.0\n", stderr: "" });
    const result = await mimoHealthcheck({});
    expect(result.ok).toBe(true);
    expect(result.cwd).toBe(process.cwd());
  });
});
