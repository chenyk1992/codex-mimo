import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveProcessLockEndpoint,
  withProcessLock
} from "../../../src/core/process-lock.js";

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-process-lock-"));
  tempDirs.push(dir);
  return dir;
}

function spawnLockChild(script: string, args: string[]): ChildProcess {
  const dir = tempDir();
  const scriptFile = path.join(dir, "lock-child.ts");
  fs.writeFileSync(scriptFile, script, "utf8");
  const viteNode = path.resolve("node_modules/vite-node/vite-node.mjs");
  const child = spawn(process.execPath, [viteNode, scriptFile, ...args], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  return child;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for child process state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("process lock", () => {
  it("maps a canonical key to one deterministic non-boundary loopback endpoint", () => {
    const first = resolveProcessLockEndpoint(path.join("relative", "job.lock"));
    const second = resolveProcessLockEndpoint(path.join("relative", ".", "job.lock"));

    expect(second).toEqual(first);
    expect(first.host).toMatch(/^127\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/);
    expect(first.port).toBeGreaterThanOrEqual(49_152);
    expect(first.port).toBeLessThanOrEqual(65_535);
  });

  it("never overlaps two processes contending for the same key", async () => {
    const dir = tempDir();
    const journal = path.join(dir, "journal.jsonl");
    const key = path.join(dir, "shared.lock");
    const processLockModule = pathToFileURL(path.resolve("src/core/process-lock.ts")).href;
    const script = `
      import fs from "node:fs";
      import { withProcessLock } from ${JSON.stringify(processLockModule)};
      const [key, journal, label] = process.argv.slice(2);
      await withProcessLock(key, async () => {
        fs.appendFileSync(journal, JSON.stringify({ label, event: "enter" }) + "\\n");
        await new Promise((resolve) => setTimeout(resolve, 150));
        fs.appendFileSync(journal, JSON.stringify({ label, event: "exit" }) + "\\n");
      }, { timeoutMs: 5_000, retryMs: 5 });
    `;

    const first = spawnLockChild(script, [key, journal, "first"]);
    const second = spawnLockChild(script, [key, journal, "second"]);
    await Promise.all([once(first, "exit"), once(second, "exit")]);

    const events = fs.readFileSync(journal, "utf8").trim().split(/\r?\n/)
      .map((line) => JSON.parse(line) as { label: string; event: string });
    expect(events.map((event) => event.event)).toEqual(["enter", "exit", "enter", "exit"]);
    expect(events[0].label).toBe(events[1].label);
    expect(events[2].label).toBe(events[3].label);
  }, 10_000);

  it("releases the endpoint when a holder process is force-killed", async () => {
    const key = path.join(tempDir(), "crash.lock");
    const processLockModule = pathToFileURL(path.resolve("src/core/process-lock.ts")).href;
    const script = `
      import { withProcessLock } from ${JSON.stringify(processLockModule)};
      await withProcessLock(process.argv[2], async () => {
        process.stdout.write("acquired\\n");
        await new Promise(() => {});
      });
    `;
    const holder = spawnLockChild(script, [key]);
    let stdout = "";
    holder.stdout!.on("data", (chunk) => { stdout += String(chunk); });
    await waitFor(() => stdout.includes("acquired"));

    holder.kill("SIGKILL");
    await once(holder, "exit");

    await expect(withProcessLock(key, () => "success", {
      timeoutMs: 2_000,
      retryMs: 10
    })).resolves.toBe("success");
  }, 10_000);

  it("allows different keys to enter concurrently", async () => {
    const dir = tempDir();
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const enter = async () => {
      entered += 1;
      await barrier;
    };

    const locks = [
      withProcessLock(path.join(dir, "first.lock"), enter),
      withProcessLock(path.join(dir, "second.lock"), enter)
    ];
    await waitFor(() => entered === 2);
    release();
    await Promise.all(locks);
  });

  it("times out while its derived endpoint is deliberately held", async () => {
    const key = path.join(tempDir(), "held.lock");

    await withProcessLock(key, async () => {
      await expect(withProcessLock(key, () => undefined, {
        timeoutMs: 40,
        retryMs: 5
      })).rejects.toThrow("Timed out acquiring process lock");
    });
  });
});
