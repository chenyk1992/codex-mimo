import { describe, expect, it } from "vitest";
import {
  ComposeInput,
  FixCiInput,
  ImplementInput,
  JobOptionsSchema,
  NotifySchema,
  PlanInput,
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
      "cwd", "model", "notify", "timeoutMs"
    ]);
  });

  it("defines a strict notification discriminated union", () => {
    expect(NotifySchema.parse({ type: "codex" })).toEqual({ type: "codex" });
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
    expect(Object.keys(PlanInput.shape).sort()).toEqual(["cwd", "model", "notify", "task", "timeoutMs"]);
    expect(Object.keys(ImplementInput.shape).sort()).toEqual(["allowWrite", "cwd", "model", "notify", "task", "timeoutMs"]);
    expect(Object.keys(ReviewInput.shape).sort()).toEqual(["base", "cwd", "model", "notify", "timeoutMs"]);
    expect(Object.keys(FixCiInput.shape).sort()).toEqual(["cwd", "file", "model", "notify", "task", "timeoutMs"]);
    expect(Object.keys(ResumeInput.shape).sort()).toEqual(["cwd", "jobId", "model", "notify", "task", "timeoutMs"]);
    expect(Object.keys(ComposeInput.shape).sort()).toEqual([
      "cwd", "file", "model", "notify", "reportDir", "since", "task", "timeoutMs", "verification", "workflow"
    ]);
  });

  it("keeps the wait polling interval private", () => {
    expect(Object.keys(JobWaitInput.shape).sort()).toEqual([
      "cwd", "jobId", "limit", "minLevel", "sinceCursor", "timeoutMs"
    ]);
    expect(() => JobWaitInput.parse({ cwd: "E:/project", pollMs: 1 })).toThrow();
  });
});
