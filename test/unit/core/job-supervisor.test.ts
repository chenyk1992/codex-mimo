import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveJobDir } from "../../../src/core/job-store.js";
import type { JobRecord } from "../../../src/core/jobs.js";
import { withProcessLock } from "../../../src/core/process-lock.js";
import type { NotificationDelivery } from "../../../src/notify/types.js";
import { runJobSupervisor } from "../../../src/core/job-supervisor.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-supervisor-"));
  roots.push(cwd);
  return cwd;
}

function job(cwd: string, status: JobRecord["status"]): JobRecord {
  return {
    id: "implement-1",
    kind: "implement",
    cwd,
    task: "work",
    request: { cwd, task: "work", allowWrite: true },
    status,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    changedFiles: [],
    verification: [],
    logFile: path.join(cwd, ".codex-mimo", "jobs", "implement-1.log"),
    eventsFile: path.join(cwd, ".codex-mimo", "jobs", "implement-1.events.jsonl"),
    signalsFile: path.join(cwd, ".codex-mimo", "jobs", "implement-1.signals.jsonl"),
    notificationOutboxFile: path.join(cwd, ".codex-mimo", "jobs", "notifications.jsonl")
  };
}

function delivery(): NotificationDelivery {
  return {
    id: "implement-1:1:codex",
    eventId: "implement-1:1:codex",
    jobId: "implement-1",
    signalCursor: 1,
    target: { type: "codex", threadId: "thread-1" },
    status: "pending",
    attempts: 0,
    createdAt: "2026-07-18T00:00:00.000Z"
  };
}

describe("job supervisor", () => {
  it("automatically replaces a crashed job worker while execution work remains", async () => {
    const cwd = workspace();
    let current = job(cwd, "running");
    const running = new Set<number>();
    let nextPid = 100;
    let sleeps = 0;
    const spawnJobWorker = vi.fn(() => {
      const pid = nextPid++;
      running.add(pid);
      return pid;
    });

    await runJobSupervisor(cwd, {
      listJobs: () => [current],
      readNotificationDeliveries: () => [],
      spawnJobWorker,
      processIsRunning: (pid) => running.has(pid),
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1) running.delete(100);
        else current = { ...current, status: "failed" };
      }
    });

    expect(spawnJobWorker.mock.calls).toEqual([[cwd, "implement-1"], [cwd, "implement-1"]]);
  });

  it("automatically replaces a crashed notification worker while delivery remains unfinished", async () => {
    const cwd = workspace();
    let unfinished: NotificationDelivery[] = [delivery()];
    const running = new Set<number>();
    let nextPid = 200;
    let sleeps = 0;
    const spawnNotificationWorker = vi.fn(() => {
      const pid = nextPid++;
      running.add(pid);
      return pid;
    });

    await runJobSupervisor(cwd, {
      listJobs: () => [],
      readNotificationDeliveries: () => unfinished,
      spawnNotificationWorker,
      processIsRunning: (pid) => running.has(pid),
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1) running.delete(200);
        else unfinished = [];
      }
    });

    expect(spawnNotificationWorker.mock.calls).toEqual([[cwd], [cwd]]);
  });

  it("allows only one supervisor for the same physical workspace", async () => {
    const cwd = workspace();
    let current = job(cwd, "queued");
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const firstSpawn = vi.fn(() => 300);
    const secondSpawn = vi.fn(() => 301);

    const first = runJobSupervisor(cwd, {
      listJobs: () => [current],
      readNotificationDeliveries: () => [],
      spawnJobWorker: firstSpawn,
      processIsRunning: () => true,
      sleep: async () => paused
    });
    await vi.waitFor(() => expect(firstSpawn).toHaveBeenCalledOnce());

    const second = runJobSupervisor(cwd, {
      listJobs: () => [current],
      readNotificationDeliveries: () => [],
      spawnJobWorker: secondSpawn,
      processIsRunning: () => true,
      sleep: async () => undefined
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondSpawn).not.toHaveBeenCalled();
    current = { ...current, status: "completed" };
    release();
    await Promise.all([first, second]);
  });

  it("hands off ownership when a launch arrives during idle shutdown", async () => {
    const cwd = workspace();
    const oldJob = job(cwd, "queued");
    const newJob = { ...job(cwd, "queued"), id: "implement-2" };
    let firstRead = true;
    let replacementActive = true;
    let replacement: Promise<void> | undefined;
    const replacementSpawn = vi.fn(() => {
      replacementActive = false;
      return 401;
    });

    await runJobSupervisor(cwd, {
      listJobs: () => {
        if (firstRead) {
          firstRead = false;
          return [oldJob];
        }
        return [];
      },
      readNotificationDeliveries: () => [],
      spawnJobWorker: () => 400,
      processIsRunning: () => true,
      sleep: async () => {
        replacement = runJobSupervisor(cwd, {
          listJobs: () => replacementActive ? [newJob] : [],
          readNotificationDeliveries: () => [],
          spawnJobWorker: replacementSpawn,
          processIsRunning: () => true,
          sleep: async () => undefined
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    });
    await replacement;

    expect(replacementSpawn).toHaveBeenCalledWith(cwd, "implement-2");
  });

  it("keeps contending for unfinished work after a slow idle-owner release", async () => {
    const cwd = workspace();
    const ownershipKey = path.join(resolveJobDir(cwd), "supervisor-ownership");
    let current: JobRecord[] = [];
    let finalScan!: () => void;
    let releaseOwner!: () => void;
    const scanned = new Promise<void>((resolve) => { finalScan = resolve; });
    const held = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const incumbent = withProcessLock(ownershipKey, async () => {
      expect(current).toEqual([]);
      finalScan();
      await held;
    });
    await scanned;

    current = [{ ...job(cwd, "queued"), id: "implement-late" }];
    const spawnJobWorker = vi.fn(() => {
      current = [];
      return 501;
    });
    const contender = runJobSupervisor(cwd, {
      listJobs: () => current,
      readNotificationDeliveries: () => [],
      spawnJobWorker,
      processIsRunning: () => true,
      sleep: async () => undefined
    });
    const stateBeforeRelease = await Promise.race([
      contender.then(() => "settled" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 350))
    ]);

    releaseOwner();
    await Promise.all([incumbent, contender]);

    expect(stateBeforeRelease).toBe("waiting");
    expect(spawnJobWorker).toHaveBeenCalledWith(cwd, "implement-late");
  });
});
