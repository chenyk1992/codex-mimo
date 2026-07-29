import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  readExecutionEvidence,
  writeExecutionEvidence
} from "../../../src/core/job-execution-evidence.js";
import type { JobRecord } from "../../../src/core/jobs.js";

function makeJob(cwd: string): JobRecord {
  return {
    id: "implement-evidence",
    kind: "implement",
    cwd,
    task: "implement",
    request: { cwd, task: "implement", allowWrite: true },
    status: "running",
    phase: "finalizing",
    pid: null,
    parentJobId: null,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    changedFiles: [],
    verification: [],
    logFile: path.join(cwd, ".codex-mimo", "jobs", "implement-evidence.log"),
    eventsFile: path.join(cwd, ".codex-mimo", "jobs", "implement-evidence.events.jsonl"),
    signalsFile: path.join(cwd, ".codex-mimo", "jobs", "implement-evidence.signals.jsonl"),
    notificationOutboxFile: path.join(cwd, ".codex-mimo", "jobs", "notifications.jsonl")
  };
}

describe("execution evidence", () => {
  it("atomically preserves reusable structural evidence without persisting secrets", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-evidence-"));
    const job = makeJob(cwd);

    const saved = writeExecutionEvidence(job, {
      reconciliationAttempts: 0,
      run: { exitCode: 0 },
      executionCallback: { invocationId: "inv-1", outcome: "completed" },
      diff: {
        changedFiles: ["src/app.ts"],
        diffStat: "1 insertion(+)",
        diff: "+token=diff-secret"
      },
      commitChanges: {
        commits: ["abc token=commit-secret"],
        changedFiles: ["src/app.ts"]
      },
      changeDetection: {
        files: ["src/app.ts"],
        candidates: [],
        status: "complete",
        sources: ["git_diff"]
      },
      commandEvidence: [{
        command: "npm test -- --token command-secret",
        cwd,
        exitCode: 0,
        eventIndex: 2,
        afterLastWrite: true,
        repositoryFingerprint: "fingerprint"
      }],
      finalRepositoryFingerprint: "fingerprint"
    }, "Done. token=result-secret");

    const raw = fs.readFileSync(saved.evidencePath, "utf8");
    expect(raw).not.toMatch(/diff-secret|commit-secret|command-secret|result-secret/);
    expect(readExecutionEvidence(job)).toMatchObject({
      commandEvidence: [{
        command: "npm test -- --token [REDACTED]",
        commandHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      }],
      diff: { diff: "+token=[REDACTED]" },
      commitChanges: { commits: ["abc token=[REDACTED]"] }
    });
    expect(fs.readFileSync(saved.resultPath!, "utf8")).toBe("Done. token=[REDACTED]");
  });
});
