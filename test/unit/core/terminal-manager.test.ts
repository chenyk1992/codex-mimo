import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalManager } from "../../../src/core/terminal.js";

const isWindows = process.platform === "win32";
const longRunningCmd = isWindows ? "ping -n 60 127.0.0.1" : "sleep 60";

describe("terminal manager", () => {
  let manager: TerminalManager;

  beforeEach(() => {
    manager = new TerminalManager();
  });

  it("5.38: create returns terminal with id", () => {
    const terminal = manager.create("echo hello", process.cwd());
    expect(terminal.id).toBeDefined();
    expect(terminal.id.startsWith("term_")).toBe(true);
  });

  it("5.39: get non-existent → undefined", () => {
    expect(manager.get("non-existent")).toBeUndefined();
  });

  it("5.40: waitForExit timeout → reject", async () => {
    const terminal = manager.create(longRunningCmd, process.cwd());
    await expect(manager.waitForExit(terminal.id, 100)).rejects.toThrow(/timed out/);
    manager.release(terminal.id);
  }, 10000);

  it("5.41: kill + release terminates and cleans up", async () => {
    const terminal = manager.create(longRunningCmd, process.cwd());
    const id = terminal.id;
    manager.kill(id);
    manager.release(id);
    expect(manager.get(id)).toBeUndefined();
  }, 10000);
});
