import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  awaitJobAttention,
  computeWaitBudgetMs,
  nextPollDelayMs,
  HOST_POLL_INTERVALS_MS,
  HOST_HOOK_SAFETY_PAD_MS
} from "../../../src/companion/host-wait.js";

describe("host-wait primitives", () => {
  it("uses 30s → 45s → 60s poll delays", () => {
    expect(nextPollDelayMs(0)).toBe(30_000);
    expect(nextPollDelayMs(1)).toBe(45_000);
    expect(nextPollDelayMs(2)).toBe(60_000);
    expect(nextPollDelayMs(99)).toBe(60_000);
    expect([...HOST_POLL_INTERVALS_MS]).toEqual([30_000, 45_000, 60_000]);
  });

  it("computes budget as min(job remaining, env, hook-pad)", () => {
    const nowMs = Date.parse("2026-07-20T00:10:00.000Z");
    const budget = computeWaitBudgetMs({
      nowMs,
      hookTimeoutMs: 1_860_000,
      jobStartedAt: "2026-07-20T00:00:00.000Z",
      jobTimeoutMs: 1_800_000,
      envWaitSec: 120
    });
    // job remaining = 1_800_000 - 600_000 = 1_200_000
    // env = 120_000
    // hook-pad = 1_860_000 - 10_000 = 1_850_000
    expect(budget).toBe(120_000);
    expect(HOST_HOOK_SAFETY_PAD_MS).toBe(10_000);
  });

  it("awaits until attention with injectable clock", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "host-wait-"));
    const jobDir = path.join(cwd, ".codex-mimo", "jobs");
    fs.mkdirSync(jobDir, { recursive: true });
    const jobFile = path.join(jobDir, "j1.json");
    fs.writeFileSync(jobFile, JSON.stringify({
      id: "j1",
      status: "running",
      startedAt: "2026-07-20T00:00:00.000Z",
      request: { timeoutMs: 1_800_000 }
    }));

    let now = 0;
    const sleeps: number[] = [];
    const outcome = await awaitJobAttention({
      cwd,
      jobId: "j1",
      budgetMs: 90_000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
        if (sleeps.length === 1) {
          fs.writeFileSync(jobFile, JSON.stringify({
            id: "j1",
            status: "completed",
            startedAt: "2026-07-20T00:00:00.000Z",
            request: { timeoutMs: 1_800_000 }
          }));
        }
      }
    });

    expect(sleeps[0]).toBe(30_000);
    expect(outcome).toEqual({ type: "attention", status: "completed" });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("returns exhausted when budget elapses while still active", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "host-wait-ex-"));
    const jobDir = path.join(cwd, ".codex-mimo", "jobs");
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, "j2.json"), JSON.stringify({
      id: "j2", status: "running", startedAt: "2026-07-20T00:00:00.000Z", request: {}
    }));
    let now = 0;
    const outcome = await awaitJobAttention({
      cwd,
      jobId: "j2",
      budgetMs: 50_000,
      now: () => now,
      sleep: async (ms) => { now += ms; }
    });
    expect(outcome.type).toBe("exhausted");
    if (outcome.type === "exhausted") {
      expect(outcome.status).toBe("running");
      expect(outcome.waitedMs).toBeGreaterThan(0);
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
