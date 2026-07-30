import { describe, expect, it } from "vitest";
import {
  ComposeInput,
  ComposeInputShape,
  FixCiInput,
  ImplementInput,
  ImplementInputBase,
  JobCancelInput,
  JobEventsInput,
  JobListInput,
  JobOptionsSchema,
  JobResultInput,
  JobStatusInput,
  NotifySchema,
  PlanInput,
  parseComposeInput,
  parseFixCiInput,
  parseResumeInput,
  ResumeInput,
  JobWaitInput,
  ReviewInput
} from "../../src/codex/tool-schemas.js";

const forbidden = [
  "background", "wait", "pollMs", "agent", "allowInstall",
  "session", "attach", "fork", "continue", "dryRun", "model"
] as const;

describe("work tool schemas", () => {
  it("accepts only the common job options", () => {
    expect(Object.keys(JobOptionsSchema.shape).sort()).toEqual([
      "cwd", "idleTimeoutMs", "notify", "progressTimeoutMs", "progressWarningMs", "timeoutMs"
    ]);
  });

  it("defaults idleTimeoutMs to 30 minutes when omitted", () => {
    expect(JobOptionsSchema.parse({ cwd: "E:/project" }).idleTimeoutMs).toBe(1_800_000);
    expect(PlanInput.parse({ cwd: "E:/project", task: "Plan" }).idleTimeoutMs).toBe(1_800_000);
    expect(ImplementInput.parse({ cwd: "E:/project", task: "Build", allowWrite: true }).idleTimeoutMs)
      .toBe(1_800_000);
  });

  it("accepts idleTimeoutMs of 0 to disable idle stop-loss", () => {
    expect(JobOptionsSchema.parse({ cwd: "E:/project", idleTimeoutMs: 0 }).idleTimeoutMs).toBe(0);
    expect(PlanInput.parse({ cwd: "E:/project", task: "Plan", idleTimeoutMs: 0 }).idleTimeoutMs).toBe(0);
  });

  it("defaults progress timeouts and accepts progressTimeoutMs 0", () => {
    const parsed = PlanInput.parse({ cwd: "E:/project", task: "x" });
    expect(parsed.progressWarningMs).toBe(120_000);
    expect(parsed.progressTimeoutMs).toBe(300_000);
    expect(PlanInput.parse({
      cwd: "E:/project",
      task: "x",
      progressTimeoutMs: 0
    }).progressTimeoutMs).toBe(0);
  });

  it("rejects negative idleTimeoutMs", () => {
    expect(() => JobOptionsSchema.parse({ cwd: "E:/project", idleTimeoutMs: -1 })).toThrow();
    expect(() => PlanInput.parse({ cwd: "E:/project", task: "Plan", idleTimeoutMs: -1 })).toThrow();
  });

  it("defines a strict notification discriminated union", () => {
    expect(() => NotifySchema.parse({ type: "codex" })).toThrow();
    expect(NotifySchema.parse({ type: "codex", threadId: "task-123" }))
      .toEqual({ type: "codex", threadId: "task-123" });
    expect(NotifySchema.parse({ type: "webhook", url: "https://example.test/hook", secretEnv: "HOOK_SECRET" }))
      .toEqual({ type: "webhook", url: "https://example.test/hook", secretEnv: "HOOK_SECRET" });
    expect(() => NotifySchema.parse({ type: "codex", url: "https://example.test" })).toThrow();
    expect(() => NotifySchema.parse({ type: "webhook", url: "https://example.test", secretEnv: "X", threadId: "t" })).toThrow();
  });

  it.each([
    [PlanInput, { cwd: "E:/project", task: "Plan" }],
    [ImplementInput, { cwd: "E:/project", task: "Build", allowWrite: true }],
    [ReviewInput, { cwd: "E:/project", base: "HEAD" }],
    [FixCiInput, { cwd: "E:/project", file: "ci.log" }],
    [ResumeInput, { cwd: "E:/project", jobId: "parent-1", task: "Continue" }],
    [ComposeInput, { cwd: "E:/project", workflow: "dev", task: "Build" }]
  ] as const)("rejects removed fields for %#", (schema, valid) => {
    for (const field of forbidden) {
      expect(() => schema.parse({ ...valid, [field]: field === "background" || field === "wait" ? true : "old" }))
        .toThrow();
    }
  });

  it("keeps exactly approved per-tool fields plus common options", () => {
    expect(Object.keys(PlanInput.shape).sort()).toEqual(["cwd", "idleTimeoutMs", "notify", "progressTimeoutMs", "progressWarningMs", "task", "timeoutMs"]);
    expect(Object.keys(ImplementInputBase.shape).sort()).toEqual(["acceptance", "allowWrite", "allowedPaths", "batchMode", "cwd", "idleTimeoutMs", "notify", "progressTimeoutMs", "progressWarningMs", "task", "timeoutMs"]);
    expect(Object.keys(ReviewInput.shape).sort()).toEqual(["base", "cwd", "idleTimeoutMs", "notify", "progressTimeoutMs", "progressWarningMs", "timeoutMs"]);
    expect(Object.keys(FixCiInput.shape).sort()).toEqual(["acceptance", "allowedPaths", "cwd", "file", "idleTimeoutMs", "notify", "progressTimeoutMs", "progressWarningMs", "task", "timeoutMs"]);
    expect(Object.keys(ResumeInput.shape).sort()).toEqual(["acceptance", "allowedPaths", "cwd", "idleTimeoutMs", "jobId", "notify", "progressTimeoutMs", "progressWarningMs", "task", "timeoutMs"]);
    expect(Object.keys(ComposeInputShape).sort()).toEqual([
      "acceptance", "allowedPaths", "batchMode", "cwd", "file", "idleTimeoutMs", "notify", "progressTimeoutMs", "progressWarningMs", "reportDir", "since", "task", "timeoutMs", "verification", "workflow"
    ]);
  });

  it("enforces workflow requirements at the public parser while keeping an MCP object schema", () => {
    expect(ComposeInput.shape).toEqual(ComposeInputShape);
    expect(() => parseComposeInput({ cwd: "E:/project", workflow: "dev" }))
      .toThrow(/requires a task/i);
    expect(() => parseComposeInput({ cwd: "E:/project", workflow: "fix-ci" }))
      .toThrow(/requires.*file/i);
    expect(() => parseComposeInput({ cwd: "E:/project", workflow: "execute-plan", task: "run" }))
      .toThrow(/requires.*file/i);
    expect(parseComposeInput({ cwd: "E:/project", workflow: "review" }))
      .toMatchObject({ workflow: "review" });
  });

  it("keeps the wait polling interval private", () => {
    expect(Object.keys(JobWaitInput.shape).sort()).toEqual([
      "cwd", "jobId", "limit", "minLevel", "sinceCursor", "timeoutMs"
    ]);
    expect(() => JobWaitInput.parse({ cwd: "E:/project", pollMs: 1 })).toThrow();
    expect(JobEventsInput.parse({ cwd: "E:/project" }).minLevel).toBe("warn");
    expect(JobWaitInput.parse({ cwd: "E:/project" }).minLevel).toBe("info");
  });

  it("describes verification as executable no-shell commands, not acceptance criteria", () => {
    const verification = ComposeInputShape.verification;
    const fieldDescription = verification.description ?? "";
    const itemDescription = verification._def.innerType.element.description ?? "";
    const combined = `${fieldDescription} ${itemDescription}`.toLowerCase();

    expect(combined).toContain("executable");
    expect(combined).toContain("command");
    expect(combined).toMatch(/not .*acceptance criteria/);
    expect(combined).toMatch(/(?:no|without a) shell/);
  });

  it("parses compose acceptance and defaults diffCheck true for callers that omit it at normalize time", () => {
    const parsed = ComposeInput.parse({
      cwd: "E:/project",
      workflow: "dev",
      task: "add endpoint",
      acceptance: { test: ["npm test -- foo.test.ts"] }
    });
    expect(parsed.acceptance).toEqual({
      test: ["npm test -- foo.test.ts"]
    });
  });

  it("accepts bounded artifact paths that do not widen source edits", () => {
    const parsed = ImplementInput.parse({
      cwd: "E:/project",
      task: "Build",
      allowWrite: true,
      batchMode: "single",
      allowedPaths: ["src/app.ts"],
      acceptance: {
        build: ["javac -d out src/app.java"],
        test: ["java -cp out AppTest"],
        artifactPaths: ["out/**"]
      }
    });

    expect(parsed.acceptance?.artifactPaths).toEqual(["out/**"]);
    const compose = parseComposeInput({
      cwd: "E:/project",
      workflow: "fix",
      task: "Fix",
      batchMode: "single",
      allowedPaths: ["src/app.ts"],
      acceptance: {
        build: ["npm run build"],
        test: ["npm test"],
        artifactPaths: ["out/**"]
      }
    });
    expect(compose.acceptance?.artifactPaths).toEqual(["out/**"]);
    expect(parseFixCiInput({
      cwd: "E:/project",
      file: "ci.log",
      allowedPaths: ["src/app.ts"],
      acceptance: {
        build: ["npm run build"],
        test: ["npm test"],
        artifactPaths: ["out/**"]
      }
    })).toMatchObject({
      allowedPaths: ["src/app.ts"],
      acceptance: { artifactPaths: ["out/**"] }
    });
    expect(parseResumeInput({
      cwd: "E:/project",
      jobId: "parent-1",
      allowedPaths: ["src/app.ts"],
      acceptance: { artifactPaths: ["out/**"] }
    }).allowedPaths).toEqual(["src/app.ts"]);
  });

  it("rejects invalid or source-overlapping artifact paths", () => {
    const base = {
      cwd: "E:/project",
      task: "Build",
      allowWrite: true,
      batchMode: "single" as const,
      allowedPaths: ["src/app.ts"]
    };

    expect(() => ImplementInput.parse({
      ...base,
      acceptance: { artifactPaths: ["**"] }
    })).toThrow(/artifactPaths/);
    expect(() => ImplementInput.parse({
      ...base,
      acceptance: { artifactPaths: ["src/**"] }
    })).toThrow(/must not overlap/);
    expect(() => parseComposeInput({
      cwd: "E:/project",
      workflow: "plan",
      task: "Plan",
      acceptance: { artifactPaths: ["out/**"] }
    })).toThrow(/does not use acceptance\.artifactPaths/);
    expect(() => parseFixCiInput({
      cwd: "E:/project",
      file: "ci.log",
      acceptance: { artifactPaths: ["**"] }
    })).toThrow(/artifactPaths/);
    expect(() => parseFixCiInput({
      cwd: "E:/project",
      file: "ci.log",
      allowedPaths: ["src/**"],
      acceptance: { artifactPaths: ["src/generated/**"] }
    })).toThrow(/must not overlap/);
    expect(() => parseResumeInput({
      cwd: "E:/project",
      jobId: "parent-1",
      allowedPaths: ["src/**"],
      acceptance: { artifactPaths: ["src/generated/**"] }
    })).toThrow(/must not overlap/);
  });

  it("still accepts legacy verification[] for migration", () => {
    const parsed = ComposeInput.parse({
      cwd: "E:/project",
      workflow: "dev",
      task: "x",
      verification: ["npm test"]
    });
    expect(parsed.verification).toEqual(["npm test"]);
  });

  it("defaults batchMode to auto for implement and compose write workflows", () => {
    expect(ImplementInput.parse({
      cwd: "E:/project",
      task: "Build",
      allowWrite: true
    }).batchMode).toBe("auto");
    expect(parseComposeInput({
      cwd: "E:/project",
      workflow: "dev",
      task: "add endpoint"
    }).batchMode).toBe("auto");
    expect(parseComposeInput({
      cwd: "E:/project",
      workflow: "execute-plan",
      task: "run plan",
      file: "docs/plan.md"
    }).batchMode).toBe("auto");
  });

  it("parses explicit batchMode single and sliced", () => {
    expect(ImplementInput.parse({
      cwd: "E:/project",
      task: "Build",
      allowWrite: true,
      batchMode: "single",
      allowedPaths: ["src/app.ts"]
    }).batchMode).toBe("single");
    expect(parseComposeInput({
      cwd: "E:/project",
      workflow: "dev",
      task: "x",
      batchMode: "sliced"
    }).batchMode).toBe("sliced");
  });

  it("strips batchMode from read-only compose workflows", () => {
    const parsed = parseComposeInput({
      cwd: "E:/project",
      workflow: "plan",
      task: "design",
      batchMode: "auto"
    });
    expect(parsed).not.toHaveProperty("batchMode");
  });

  it.each(["fix-ci", "parallel", "worktree", "merge", "new-skill"] as const)(
    "leaves topology-owning workflow %s out of bridge slice orchestration",
    (workflow) => {
      const input = workflow === "fix-ci"
        ? { cwd: "E:/project", workflow, file: "ci.log", batchMode: "sliced" as const }
        : { cwd: "E:/project", workflow, task: "run workflow", batchMode: "sliced" as const };
      expect(parseComposeInput(input)).not.toHaveProperty("batchMode");
    }
  );
});

describe("control tool schemas", () => {
  it.each([
    JobStatusInput,
    JobEventsInput,
    JobWaitInput,
    JobResultInput,
    JobCancelInput,
    JobListInput
  ] as const)("rejects empty cwd like work tools %#", (schema) => {
    const cancelFields = schema === JobCancelInput ? { jobId: "job-1" } : {};
    expect(() => schema.parse({ cwd: "", ...cancelFields })).toThrow();
    expect(schema.parse({ cwd: "E:/project", ...cancelFields })).toMatchObject({ cwd: "E:/project" });
  });

  it.each([JobStatusInput, JobResultInput])(
    "defaults output level to compact and accepts explicit levels %#",
    (schema) => {
      expect(schema.parse({ cwd: "E:/project" })).toMatchObject({
        cwd: "E:/project",
        level: "compact"
      });
      expect(schema.parse({ cwd: "E:/project", level: "standard" }).level).toBe("standard");
      expect(schema.parse({ cwd: "E:/project", level: "full" }).level).toBe("full");
      expect(() => schema.parse({ cwd: "E:/project", level: "verbose" })).toThrow();
    }
  );
});
