import { describe, expect, it } from "vitest";
import { renderJobLaunch, renderJobResult, renderJobStatus } from "../../src/core/job-render.js";
import type { JobRecord } from "../../src/core/jobs.js";

function job(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "compose-1",
    kind: "compose",
    workflow: "dev",
    cwd: "E:/project/app",
    task: "Implement login throttling",
    request: { workflow: "dev" },
    status: "running",
    phase: "verifying",
    pid: 123,
    sessionId: "sess_123",
    parentJobId: null,
    createdAt: "2026-06-23T00:00:00.000Z",
    startedAt: "2026-06-23T00:00:01.000Z",
    updatedAt: "2026-06-23T00:00:02.000Z",
    changedFiles: ["src/login.ts"],
    verification: [],
    summary: "Running npm test.",
    logFile: "job.log",
    eventsFile: "job.events.jsonl",
    ...patch
  };
}

describe("job rendering", () => {
  it("renders background launch response", () => {
    expect(renderJobLaunch(job({ status: "queued", phase: "queued" }))).toEqual({
      jobId: "compose-1",
      status: "queued",
      phase: "queued",
      summary: "Started compose job compose-1.",
      actions: {
        status: "mimo_status",
        result: "mimo_result",
        cancel: "mimo_cancel"
      }
    });
  });

  it("renders status with progress and cancel action for active jobs", () => {
    const result = renderJobStatus(job(), {
      nowMs: Date.parse("2026-06-23T00:00:11.000Z"),
      progress: ["Running npm test."]
    });

    expect(result.elapsedMs).toBe(10000);
    expect(result.actions.cancel).toBe("mimo_cancel");
    expect(result.progress).toEqual(["Running npm test."]);
  });

  it("renders result with resume hint when a session exists", () => {
    const result = renderJobResult(job({
      status: "completed",
      phase: "done",
      reportPaths: { json: "report.json", markdown: "report.md" }
    }));

    expect(result.resumeHint).toEqual({ tool: "mimo_resume_job", jobId: "compose-1" });
    expect(result.reportPaths?.json).toBe("report.json");
  });
});
