import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mimoCompose,
  mimoFixCi,
  mimoImplement,
  mimoPlan,
  mimoReview
} from "../../src/codex/tools.js";
import { MIMO_TOOL_NAMES } from "../../src/codex/tool-names.js";
import {
  ComposeInput,
  FixCiInput,
  ImplementInput,
  PlanInput,
  ResumeInput,
  ReviewInput
} from "../../src/codex/tool-schemas.js";
import type { JobKind } from "../../src/core/jobs.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("codex work tool handlers", () => {
  it.each([
    ["mimo_plan", "plan", (cwd: string, spawnJobSupervisor: () => number) =>
      mimoPlan({ cwd, task: "Plan it" }, { env: {}, spawnJobSupervisor })],
    ["mimo_implement", "implement", (cwd: string, spawnJobSupervisor: () => number) =>
      mimoImplement({ cwd, task: "Build it", allowWrite: true }, { env: {}, spawnJobSupervisor })],
    ["mimo_review", "review", (cwd: string, spawnJobSupervisor: () => number) =>
      mimoReview({ cwd, base: "HEAD" }, { env: {}, spawnJobSupervisor })],
    ["mimo_fix_ci", "fix-ci", (cwd: string, spawnJobSupervisor: () => number) =>
      mimoFixCi({ cwd, file: "ci.log", task: "Fix" }, { env: {}, spawnJobSupervisor })],
    ["mimo_compose", "compose", (cwd: string, spawnJobSupervisor: () => number) =>
      mimoCompose({ cwd, workflow: "dev", task: "Build" }, { env: {}, spawnJobSupervisor })]
  ] as const)("%s returns only a queued %s receipt", async (_name, kind: JobKind, run) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-work-tool-"));
    dirs.push(cwd);
    const spawnJobSupervisor = vi.fn().mockReturnValue(123);
    const result = await run(cwd, spawnJobSupervisor);
    expect(result).toEqual({
      jobId: expect.any(String),
      kind,
      status: "queued",
      actions: {
        status: "mimo_status",
        events: "mimo_events",
        result: "mimo_result",
        cancel: "mimo_cancel"
      }
    });
    expect(spawnJobSupervisor).toHaveBeenCalledWith(cwd);
  });

  it("exposes exactly the final 13-tool surface", () => {
    expect(MIMO_TOOL_NAMES).toEqual([
      "mimo_healthcheck",
      "mimo_plan",
      "mimo_implement",
      "mimo_review",
      "mimo_fix_ci",
      "mimo_resume",
      "mimo_compose",
      "mimo_status",
      "mimo_events",
      "mimo_wait",
      "mimo_result",
      "mimo_cancel",
      "mimo_jobs"
    ]);
    expect(MIMO_TOOL_NAMES).not.toContain("mimo_wake");
    expect(MIMO_TOOL_NAMES).not.toContain("mimo_resume_job");
  });

  it("contains no superseded runtime identifiers in source", () => {
    const sourceFiles = collectTypeScriptFiles(path.resolve("src"));
    const forbidden = [
      /mimo_wake/g,
      /mimo_resume_job/g,
      /compose-worker/g,
      /runAndCapture/g,
      /runComposeWorkflow/g,
      /runComposeJobWorker/g,
      /JobWakeHint/g,
      /JobKind[^\n]*["']acp["']/g
    ];
    const matches = sourceFiles.flatMap((file) => {
      const contents = fs.readFileSync(file, "utf8");
      return forbidden.flatMap((pattern) =>
        [...contents.matchAll(pattern)].map((match) => `${path.relative(process.cwd(), file)}:${match[0]}`)
      );
    });
    expect(matches).toEqual([]);
  });

  it("keeps background and wait out of every work tool schema", () => {
    for (const schema of [PlanInput, ImplementInput, ReviewInput, FixCiInput, ResumeInput, ComposeInput]) {
      expect(schema.keyof().options).not.toContain("background");
      expect(schema.keyof().options).not.toContain("wait");
    }
  });
});

function collectTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(target);
    return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
  });
}
