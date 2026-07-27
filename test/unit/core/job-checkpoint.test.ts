import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeRepositoryFingerprint,
  detectResumeConflict,
  readJobCheckpoint,
  writeJobCheckpoint
} from "../../../src/core/job-checkpoint.js";
import type { JobRecord } from "../../../src/core/jobs.js";

const roots: string[] = [];

function tempGitWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-checkpoint-"));
  roots.push(cwd);
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "checkpoint@example.test"], { cwd });
  execFileSync("git", ["config", "user.name", "Checkpoint Test"], { cwd });
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 1;\n", "utf8");
  execFileSync("git", ["add", "src/a.ts"], { cwd });
  execFileSync("git", ["commit", "-m", "base"], { cwd, stdio: "ignore" });
  return cwd;
}

function sampleJob(cwd: string): JobRecord {
  return {
    id: "job-checkpoint-1",
    kind: "implement",
    cwd,
    task: "Implement feature",
    request: { cwd, task: "Implement feature" },
    status: "running",
    processIdentity: null,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:01.000Z",
    changedFiles: ["src/a.ts"],
    verification: [],
    logFile: path.join(cwd, ".codex-mimo", "jobs", "job-checkpoint-1.log"),
    eventsFile: path.join(cwd, ".codex-mimo", "jobs", "job-checkpoint-1.events.jsonl"),
    signalsFile: path.join(cwd, ".codex-mimo", "jobs", "job-checkpoint-1.signals.jsonl"),
    notificationOutboxFile: path.join(cwd, ".codex-mimo", "jobs", "job-checkpoint-1.notifications.jsonl"),
    sessionId: "ses_checkpoint",
    lastProgressAt: "2026-07-26T00:00:01.000Z",
    lastProgressKind: "file_change",
    lastCommand: "npm test"
  };
}

afterEach(() => {
  for (const cwd of roots.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
});

describe("writeJobCheckpoint", () => {
  it("atomically writes checkpoint.json and updates reportPaths.checkpoint", async () => {
    const cwd = tempGitWorkspace();
    const job = sampleJob(cwd);
    const paths = await writeJobCheckpoint({
      job,
      objective: job.task,
      changedFiles: job.changedFiles
    });

    expect(fs.existsSync(paths.checkpoint!)).toBe(true);
    const parsed = readJobCheckpoint(paths.checkpoint!);
    expect(parsed?.version).toBe(1);
    expect(parsed?.chainId).toBe(job.id);
    expect(parsed?.completedSlices).toEqual([]);
    expect(parsed?.acceptance.stages).toEqual([]);
    expect(parsed?.completedChecklist).toEqual([]);
    expect(parsed?.remainingChecklist).toEqual([
      "Continue from the last incomplete step in the objective."
    ]);
    expect(parsed?.repositoryFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed?.artifactPaths.checkpoint).toBe(paths.checkpoint);
  });

  it("merges checkpoint into existing report paths without wiping semantic artifacts", async () => {
    const cwd = tempGitWorkspace();
    const job = sampleJob(cwd);
    const existing = {
      json: path.join(cwd, ".codex-mimo", "reports", `${job.id}.json`),
      result: path.join(cwd, ".codex-mimo", "reports", `${job.id}.result.md`)
    };
    const paths = await writeJobCheckpoint({
      job,
      objective: job.task,
      changedFiles: job.changedFiles,
      existingReportPaths: existing
    });

    expect(paths.json?.replace(/\\/g, "/")).toBe(existing.json.replace(/\\/g, "/"));
    expect(paths.result?.replace(/\\/g, "/")).toBe(existing.result.replace(/\\/g, "/"));
    expect(paths.checkpoint).toMatch(/\.checkpoint\.json$/);
  });
});

describe("detectResumeConflict", () => {
  it("detects resume_conflict when repository fingerprint changes", async () => {
    const cwd = tempGitWorkspace();
    const job = sampleJob(cwd);
    const paths = await writeJobCheckpoint({
      job,
      objective: job.task,
      changedFiles: job.changedFiles
    });
    const checkpoint = readJobCheckpoint(paths.checkpoint!)!;

    expect(detectResumeConflict(checkpoint, {
      repositoryFingerprint: "different"
    })).toEqual({
      code: "resume_conflict",
      paths: expect.any(Array)
    });
  });

  it("returns null when repository fingerprint matches", async () => {
    const cwd = tempGitWorkspace();
    const job = sampleJob(cwd);
    const paths = await writeJobCheckpoint({
      job,
      objective: job.task,
      changedFiles: job.changedFiles
    });
    const checkpoint = readJobCheckpoint(paths.checkpoint!)!;

    expect(detectResumeConflict(checkpoint, {
      repositoryFingerprint: checkpoint.repositoryFingerprint
    })).toBeNull();
  });
});

describe("computeRepositoryFingerprint", () => {
  it("hashes HEAD plus only the relevant file fingerprints", () => {
    const head = "abc123";
    const files = ["src/a.ts", "src/b.ts"];
    const fingerprints = {
      "src/a.ts": { status: " M", contentHash: "hash-a" },
      "src/b.ts": { status: " M", contentHash: "hash-b" }
    };
    const first = computeRepositoryFingerprint(head, files, fingerprints);
    const second = computeRepositoryFingerprint(head, files, fingerprints);
    const fewerFiles = computeRepositoryFingerprint(head, ["src/a.ts"], fingerprints);

    expect(first).toBe(second);
    expect(fewerFiles).not.toBe(first);
    expect(first).toBe(
      crypto.createHash("sha256")
        .update(["abc123", "src/a.ts:hash-a", "src/b.ts:hash-b"].join("\n"))
        .digest("hex")
    );
  });
});
