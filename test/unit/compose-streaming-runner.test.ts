import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runMimoCliStreaming } from "../../src/compose/streaming-runner.js";

describe("streaming MiMo CLI runner", () => {
  it("streams JSONL events and returns captured stdout", async () => {
    const seen: string[] = [];
    const result = await runMimoCliStreaming("E:/project/app", ["run"], {
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
          pid: number;
          kill: () => boolean;
        };
        child.pid = 123;
        child.stdout = Readable.from([
          "{\"type\":\"message\",\"text\":\"hello\"}\n",
          "{\"type\":\"tool\",\"tool\":\"bash\",\"status\":\"completed\"}\n"
        ]);
        child.stderr = Readable.from([""]);
        child.kill = () => true;
        queueMicrotask(() => child.emit("close", 0));
        return child;
      },
      onLine: (line) => seen.push(line)
    });

    expect(result.exitCode).toBe(0);
    expect(result.pid).toBe(123);
    expect(seen).toEqual([
      "{\"type\":\"message\",\"text\":\"hello\"}",
      "{\"type\":\"tool\",\"tool\":\"bash\",\"status\":\"completed\"}"
    ]);
    expect(result.stdout).toContain("\"hello\"");
  });

  it("returns stderr and nonzero exit code", async () => {
    const result = await runMimoCliStreaming("E:/project/app", ["run"], {
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
          pid: number;
          kill: () => boolean;
        };
        child.pid = 456;
        child.stdout = Readable.from([""]);
        child.stderr = Readable.from(["failed\n"]);
        child.kill = () => true;
        queueMicrotask(() => child.emit("close", 2));
        return child;
      }
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("failed\n");
  });

  it("terminates the process tree on timeout", async () => {
    let killedPid: number | null | undefined;
    const result = await runMimoCliStreaming("E:/project/app", ["run"], {
      timeoutMs: 1,
      spawnProcess: () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
          pid: number;
          kill: () => boolean;
        };
        child.pid = 789;
        child.stdout = Readable.from([""]);
        child.stderr = Readable.from([""]);
        child.kill = () => true;
        return child;
      },
      terminateProcessTree: (pid, child) => {
        killedPid = pid;
        queueMicrotask(() => child.emit("close", null));
      }
    });

    expect(killedPid).toBe(789);
    expect(result.exitCode).toBe(124);
  });
});
