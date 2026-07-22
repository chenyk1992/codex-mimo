import { describe, expect, it } from "vitest";
import {
  ComposeInput,
  ComposeInputShape,
  FixCiInput,
  ImplementInput,
  JobCancelInput,
  JobEventsInput,
  JobListInput,
  JobOptionsSchema,
  JobResultInput,
  JobStatusInput,
  NotifySchema,
  PlanInput,
  parseComposeInput,
  ResumeInput,
  JobWaitInput,
  ReviewInput
} from "../../src/codex/tool-schemas.js";

const forbidden = [
  "background", "wait", "pollMs", "agent", "allowInstall",
  "session", "attach", "fork", "continue", "dryRun"
] as const;

describe("work tool schemas", () => {
  it("accepts only the common job options", () => {
    expect(Object.keys(JobOptionsSchema.shape).sort()).toEqual([
      "cwd", "idleTimeoutMs", "model", "notify", "timeoutMs"
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
    expect(Object.keys(PlanInput.shape).sort()).toEqual(["cwd", "idleTimeoutMs", "model", "notify", "task", "timeoutMs"]);
    expect(Object.keys(ImplementInput.shape).sort()).toEqual(["allowWrite", "cwd", "idleTimeoutMs", "model", "notify", "task", "timeoutMs"]);
    expect(Object.keys(ReviewInput.shape).sort()).toEqual(["base", "cwd", "idleTimeoutMs", "model", "notify", "timeoutMs"]);
    expect(Object.keys(FixCiInput.shape).sort()).toEqual(["cwd", "file", "idleTimeoutMs", "model", "notify", "task", "timeoutMs"]);
    expect(Object.keys(ResumeInput.shape).sort()).toEqual(["cwd", "idleTimeoutMs", "jobId", "model", "notify", "task", "timeoutMs"]);
    expect(Object.keys(ComposeInputShape).sort()).toEqual([
      "cwd", "file", "idleTimeoutMs", "model", "notify", "reportDir", "since", "task", "timeoutMs", "verification", "workflow"
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
});
