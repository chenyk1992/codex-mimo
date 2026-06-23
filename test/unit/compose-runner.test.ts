import { describe, expect, it } from "vitest";
import { buildComposeReportFromRun, runComposeWorkflow } from "../../src/compose/runner.js";

describe("compose runner", () => {
  it("builds a compose report from captured streaming stdout", () => {
    const report = buildComposeReportFromRun({
      id: "run-1",
      createdAt: "2026-06-23T00:00:00.000Z",
      input: {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Implement login throttling"
      },
      mimoArgs: ["run", "--format", "json"],
      requestedSkills: ["compose:brainstorm"],
      eventsStdout: "{\"type\":\"message\",\"text\":\"done\"}\n",
      diff: {
        changedFiles: ["src/login.ts"],
        diffStat: "src/login.ts | 1 +",
        diff: ""
      },
      verification: [],
      reportDir: "E:/project/app/.codex-mimo/reports",
      eventsDir: "E:/project/app/.codex-mimo/events",
      diffsDir: "E:/project/app/.codex-mimo/diffs",
      status: "needs_review"
    });

    expect(report.reviewText).toBe("done");
    expect(report.reportPaths.json).toContain("run-1.json");
  });

  it("extracts planText from events containing plan structure", () => {
    const planContent = "# Implementation Plan\n\n## Task 1: Setup\n\n- [ ] Step 1: Create files\n- [ ] Step 2: Run tests";
    const report = buildComposeReportFromRun({
      id: "run-plan",
      createdAt: "2026-06-23T00:00:00.000Z",
      input: { cwd: "E:/project/app", workflow: "plan", task: "Write a plan" },
      mimoArgs: ["run", "--format", "json"],
      requestedSkills: ["compose:plan"],
      eventsStdout: `{"type":"message","text":"Analyzing codebase..."}\n{"type":"message","text":"${planContent.replace(/\n/g, "\\n")}"}\n`,
      diff: { changedFiles: [], diffStat: "", diff: "" },
      verification: [],
      reportDir: "E:/project/app/.codex-mimo/reports",
      eventsDir: "E:/project/app/.codex-mimo/events",
      diffsDir: "E:/project/app/.codex-mimo/diffs",
      status: "passed"
    });

    expect(report.planText).toContain("Implementation Plan");
    expect(report.planText).toContain("Task 1");
    expect(report.reviewText).toBeDefined();
  });

  it("leaves planText undefined when no plan content found", () => {
    const report = buildComposeReportFromRun({
      id: "run-no-plan",
      createdAt: "2026-06-23T00:00:00.000Z",
      input: { cwd: "E:/project/app", workflow: "dev", task: "Fix bug" },
      mimoArgs: ["run", "--format", "json"],
      requestedSkills: ["compose:debug"],
      eventsStdout: `{"type":"message","text":"Found the bug in line 42"}\n`,
      diff: { changedFiles: [], diffStat: "", diff: "" },
      verification: [],
      reportDir: "E:/project/app/.codex-mimo/reports",
      eventsDir: "E:/project/app/.codex-mimo/events",
      diffsDir: "E:/project/app/.codex-mimo/diffs",
      status: "passed"
    });

    expect(report.planText).toBeUndefined();
    expect(report.reviewText).toBe("Found the bug in line 42");
  });

  it("runs MiMoCode, captures events, diff, verification, and report", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Implement login throttling",
        verification: ["npm test"],
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"message","text":"done"}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: ["src/login.ts"],
          diffStat: " src/login.ts | 10 ++++++++++",
          diff: "diff --git a/src/login.ts b/src/login.ts"
        }),
        captureStatus: async () => ({
          short: " M src/login.ts",
          dirty: true
        }),
        runVerification: async () => [
          {
            command: "npm test",
            exitCode: 0,
            stdout: "ok",
            stderr: "",
            passed: true,
            durationMs: 10
          }
        ],
        writeReport: () => undefined,
        now: () => new Date("2026-06-21T18:40:00.000Z")
      }
    );

    expect(result.status).toBe("passed");
    expect(result.changedFiles).toEqual(["src/login.ts"]);
    expect(result.events).toHaveLength(1);
    expect(result.gitStatusBefore).toBeDefined();
    expect(result.gitStatusAfter).toBeDefined();
    expect(result.diffPath).toBeDefined();
  });

  it("writes report on dry-run", async () => {
    let reportWritten = false;
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Test task",
        dryRun: true,
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        writeReport: () => { reportWritten = true; },
        now: () => new Date("2026-06-21T18:40:00.000Z")
      }
    );

    expect(result.status).toBe("needs_review");
    expect(reportWritten).toBe(true);
  });

  it("writes report when MiMoCode execution fails", async () => {
    let reportWritten = false;
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Test task",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => { throw new Error("mimo not found"); },
        writeReport: () => { reportWritten = true; },
        now: () => new Date("2026-06-21T18:40:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MiMoCode execution failed");
    expect(reportWritten).toBe(true);
  });

  it("passes timeout to MiMoCode runner", async () => {
    let capturedTimeout: number | undefined;
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "plan",
        task: "Create a concise validation plan.",
        timeoutMs: 110000,
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async (_cwd, _args, options) => {
          capturedTimeout = options?.timeoutMs;
          return {
            stdout: '{"type":"message","text":"done"}\n',
            stderr: "",
            exitCode: 0
          };
        },
        captureDiff: async () => ({
          changedFiles: [],
          diffStat: "",
          diff: ""
        }),
        captureStatus: async () => ({
          short: "",
          dirty: false
        }),
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-22T13:00:00.000Z")
      }
    );

    expect(capturedTimeout).toBe(110000);
    expect(result.status).toBe("passed");
  });

  it("writes report when git diff capture fails", async () => {
    let reportWritten = false;
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Test task",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"message","text":"done"}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => { throw new Error("not a git repo"); },
        writeReport: () => { reportWritten = true; },
        now: () => new Date("2026-06-21T18:40:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Git diff capture failed");
    expect(reportWritten).toBe(true);
  });

  it("writes report when verification fails", async () => {
    let reportWritten = false;
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Test task",
        verification: ["npm test"],
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"message","text":"done"}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: ["src/login.ts"],
          diffStat: " src/login.ts | 10 ++++++++++",
          diff: ""
        }),
        runVerification: async () => { throw new Error("test command not found"); },
        writeReport: () => { reportWritten = true; },
        now: () => new Date("2026-06-21T18:40:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Verification execution failed");
    expect(reportWritten).toBe(true);
  });

  it("marks status as failed when verification command fails", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Test task",
        verification: ["npm test"],
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"message","text":"done"}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: ["src/login.ts"],
          diffStat: " src/login.ts | 10 ++++++++++",
          diff: ""
        }),
        runVerification: async () => [
          {
            command: "npm test",
            exitCode: 1,
            stdout: "FAIL",
            stderr: "test failed",
            passed: false,
            durationMs: 100
          }
        ],
        writeReport: () => undefined,
        now: () => new Date("2026-06-21T18:40:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.verification[0].passed).toBe(false);
  });

  it("marks status as needs_review when no verification but files changed", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Test task",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"message","text":"done"}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: ["src/login.ts"],
          diffStat: " src/login.ts | 10 ++++++++++",
          diff: ""
        }),
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-21T18:40:00.000Z")
      }
    );

    expect(result.status).toBe("needs_review");
  });

  it("marks read-only workflows as failed when MiMoCode changes files", async () => {
    let statusCalls = 0;
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "brainstorm",
        task: "Clarify requirements",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"message","text":"I changed a file."}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: ["src/unexpected.ts"],
          diffStat: " src/unexpected.ts | 1 +",
          diff: "diff --git a/src/unexpected.ts b/src/unexpected.ts"
        }),
        captureStatus: async () => {
          statusCalls += 1;
          return statusCalls === 1
            ? { short: "", dirty: false }
            : { short: " M src/unexpected.ts", dirty: true };
        },
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-22T03:10:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.changedFiles).toEqual(["src/unexpected.ts"]);
    expect(result.error).toContain("Read-only workflow brainstorm modified files");
    expect(result.diffPath).toBeDefined();
  });

  it("marks read-only workflows as failed when MiMoCode creates untracked files", async () => {
    let statusCalls = 0;
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "plan",
        task: "Write a plan without editing files",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"message","text":"Created package.json"}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: [],
          diffStat: "",
          diff: ""
        }),
        captureStatus: async () => {
          statusCalls += 1;
          return statusCalls === 1
            ? { short: "", dirty: false }
            : { short: "?? package.json\n?? smoke.test.js", dirty: true };
        },
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-22T10:00:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.changedFiles).toEqual(["package.json", "smoke.test.js"]);
    expect(result.error).toContain("Read-only workflow plan modified files: package.json, smoke.test.js");
  });

  it("does not report pre-existing dirty files as read-only workflow changes", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "brainstorm",
        task: "Clarify requirements",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"message","text":"No file changes needed."}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: ["src/existing.ts"],
          diffStat: " src/existing.ts | 1 +",
          diff: "diff --git a/src/existing.ts b/src/existing.ts"
        }),
        captureStatus: async () => ({
          short: " M src/existing.ts",
          dirty: true
        }),
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-22T03:10:30.000Z")
      }
    );

    expect(result.status).toBe("passed");
    expect(result.error).toBeUndefined();
    expect(result.changedFiles).toEqual([]);
    expect(result.diffStat).toBe("");
    expect(result.diffPath).toBeUndefined();
  });

  it("marks MiMoCode empty-objective clarification as failed", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "plan",
        task: "Write a validation plan",
        verification: ["npm run build"],
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"message","text":"It looks like the objective is empty. What would you like me to help with?"}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: [],
          diffStat: "",
          diff: ""
        }),
        captureStatus: async () => ({
          short: "",
          dirty: false
        }),
        runVerification: async () => [
          {
            command: "npm run build",
            exitCode: 0,
            stdout: "ok",
            stderr: "",
            passed: true,
            durationMs: 10
          }
        ],
        writeReport: () => undefined,
        now: () => new Date("2026-06-22T03:11:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MiMoCode did not receive or accept the task objective");
    expect(result.reviewText).toContain("objective is empty");
  });

  it("marks MiMoCode cut-off objective clarification as failed", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "plan",
        task: "Create a concise read-only validation plan.",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout:
            "{\"type\":\"message\",\"text\":\"It looks like your message got cut off — what's the objective or task you'd like help with?\"}\n",
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: [],
          diffStat: "",
          diff: ""
        }),
        captureStatus: async () => ({
          short: "",
          dirty: false
        }),
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-22T04:30:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MiMoCode did not receive or accept the task objective");
    expect(result.reviewText).toContain("message got cut off");
  });

  it("marks MiMoCode missing actual task clarification as failed", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "brainstorm",
        task: "Clarify whether this tiny smoke fixture needs any changes.",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout:
            `{"type":"message","text":"I see you've loaded the compose agent environment with all the skills, but you haven't provided an actual task or objective yet.\\n\\nWhat would you like me to help you with? Please share your task, and I'll use the appropriate skills to assist you."}\n`,
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: [],
          diffStat: "",
          diff: ""
        }),
        captureStatus: async () => ({
          short: "",
          dirty: false
        }),
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-22T04:31:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MiMoCode did not receive or accept the task objective");
    expect(result.reviewText).toContain("haven't provided an actual task or objective");
  });

  it("marks MiMoCode work-on clarification as failed", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "plan",
        task: "Create a concise read-only validation plan.",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"message","text":"What would you like to work on?"}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: [],
          diffStat: "",
          diff: ""
        }),
        captureStatus: async () => ({
          short: "",
          dirty: false
        }),
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-22T04:50:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MiMoCode did not receive or accept the task objective");
    expect(result.reviewText).toContain("What would you like to work on?");
  });

  it("marks MiMoCode raw message task clarification as failed", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "plan",
        task: "Create a concise read-only validation plan.",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout:
            '{"type":"message","raw":{"type":"text","part":{"type":"text","text":"It looks like your message got cut off. What would you like to accomplish?"}}}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: [],
          diffStat: "",
          diff: ""
        }),
        captureStatus: async () => ({
          short: "",
          dirty: false
        }),
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-22T04:52:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MiMoCode did not receive or accept the task objective");
    expect(result.reviewText).toContain("What would you like to accomplish?");
  });

  it("marks MiMoCode top-level text-part clarification as failed", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "plan",
        task: "Create a concise read-only validation plan.",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout:
            '{"type":"text","part":{"type":"text","text":"What would you like me to help with?"}}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: [],
          diffStat: "",
          diff: ""
        }),
        captureStatus: async () => ({
          short: "",
          dirty: false
        }),
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-22T08:36:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MiMoCode did not receive or accept the task objective");
    expect(result.reviewText).toContain("What would you like me to help with?");
  });

  it("marks terse MiMoCode readiness prompt as failed", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "plan",
        task: "Create a concise read-only validation plan.",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"text","part":{"type":"text","text":"Ready. What do you need?"}}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: [],
          diffStat: "",
          diff: ""
        }),
        captureStatus: async () => ({
          short: "",
          dirty: false
        }),
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-22T08:40:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MiMoCode did not receive or accept the task objective");
    expect(result.reviewText).toContain("Ready. What do you need?");
  });

  it("marks generic MiMoCode help prompt as failed", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "plan",
        task: "Create a concise read-only validation plan.",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout: '{"type":"text","part":{"type":"text","text":"How can I help you?"}}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: [],
          diffStat: "",
          diff: ""
        }),
        captureStatus: async () => ({
          short: "",
          dirty: false
        }),
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-22T10:05:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MiMoCode did not receive or accept the task objective");
    expect(result.reviewText).toContain("How can I help you?");
  });

  it("marks generic MiMoCode task prompt as failed", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "review",
        task: "Review the current diff.",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout:
            '{"type":"text","part":{"type":"text","text":"How can I help? What task or problem would you like to work on?"}}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: [],
          diffStat: "",
          diff: ""
        }),
        captureStatus: async () => ({
          short: "",
          dirty: false
        }),
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-22T11:06:30.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MiMoCode did not receive or accept the task objective");
    expect(result.reviewText).toContain("What task or problem would you like to work on?");
  });

  it("marks unavailable-skill clarification prompts as failed", async () => {
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "plan",
        task: "Read the README and write a concise validation plan.",
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async () => ({
          stdout:
            '{"type":"text","part":{"type":"text","text":"The skill \\"arch:android-misconfig\\" is not available.\\n\\nWhat are you trying to accomplish?"}}\n',
          stderr: "",
          exitCode: 0
        }),
        captureDiff: async () => ({
          changedFiles: [],
          diffStat: "",
          diff: ""
        }),
        captureStatus: async () => ({
          short: "",
          dirty: false
        }),
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-22T10:16:00.000Z")
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MiMoCode did not receive or accept the task objective");
    expect(result.reviewText).toContain("What are you trying to accomplish?");
  });

  it("supports --continue flag", async () => {
    let capturedArgs: string[] = [];
    const result = await runComposeWorkflow(
      {
        cwd: "E:/project/app",
        workflow: "dev",
        task: "Continue task",
        continue: true,
        reportDir: "E:/project/app/.codex-mimo/reports"
      },
      {
        runMimo: async (_cwd, args) => {
          capturedArgs = args;
          return {
            stdout: '{"type":"message","text":"done"}\n',
            stderr: "",
            exitCode: 0
          };
        },
        captureDiff: async () => ({
          changedFiles: [],
          diffStat: "",
          diff: ""
        }),
        runVerification: async () => [],
        writeReport: () => undefined,
        now: () => new Date("2026-06-21T18:40:00.000Z")
      }
    );

    expect(capturedArgs).toContain("--continue");
    expect(result.status).toBe("passed");
  });
});
