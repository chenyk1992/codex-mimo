import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareExecutionWorkspace } from "../../../src/core/execution-workspace.js";
import {
  applyWorkspacePromotion,
  createWorkspacePromotionPlan
} from "../../../src/core/workspace-promotion.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe("workspace-promotion", () => {
  it("promotes an allowed write atomically and keeps declared artifacts out of the control tree", () => {
    const controlRoot = temporaryDirectory("control-");
    fs.mkdirSync(path.join(controlRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(controlRoot, "out"), { recursive: true });
    fs.writeFileSync(path.join(controlRoot, "src", "app.ts"), "before\n");
    const prepared = prepare(controlRoot);
    fs.writeFileSync(path.join(prepared.executionRoot, "src", "app.ts"), "after\n");
    fs.writeFileSync(path.join(prepared.executionRoot, "out", "result.txt"), "artifact\n");

    const plan = createWorkspacePromotionPlan({
      baseline: prepared.baseline,
      executionRoot: prepared.executionRoot,
      allowedPaths: ["src/**"],
      artifactPaths: ["out/**"]
    });
    expect(plan).toMatchObject({ passed: true, artifactFiles: ["out/result.txt"] });
    expect(plan.operations).toEqual([expect.objectContaining({ kind: "upsert_file", path: "src/app.ts" })]);

    const result = applyWorkspacePromotion({ ...prepared, controlRoot, plan });
    expect(result).toMatchObject({ passed: true, appliedPaths: ["src/app.ts"] });
    expect(fs.readFileSync(path.join(controlRoot, "src", "app.ts"), "utf8")).toBe("after\n");
    expect(fs.existsSync(path.join(controlRoot, "out", "result.txt"))).toBe(false);
    expect(result.journalPath).toBeTruthy();
  });

  it("returns a scope failure without contaminating the control workspace", () => {
    const controlRoot = temporaryDirectory("control-");
    fs.mkdirSync(path.join(controlRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(controlRoot, "src", "allowed.ts"), "before\n");
    const prepared = prepare(controlRoot);
    fs.writeFileSync(path.join(prepared.executionRoot, "src", "allowed.ts"), "changed\n");
    fs.mkdirSync(path.join(prepared.executionRoot, "docs"));
    fs.writeFileSync(path.join(prepared.executionRoot, "docs", "escape.md"), "escape\n");

    const plan = createWorkspacePromotionPlan({
      baseline: prepared.baseline,
      executionRoot: prepared.executionRoot,
      allowedPaths: ["src/**"]
    });
    expect(plan).toMatchObject({ passed: false, failureCode: "promotion_scope_violation" });
    expect(plan.outOfScopePaths).toContain("docs/escape.md");
    const result = applyWorkspacePromotion({ ...prepared, controlRoot, plan });
    expect(result).toMatchObject({ passed: false, failureCode: "promotion_scope_violation" });
    expect(fs.readFileSync(path.join(controlRoot, "src", "allowed.ts"), "utf8")).toBe("before\n");
    expect(fs.existsSync(path.join(controlRoot, "docs", "escape.md"))).toBe(false);
  });

  it("never promotes bridge runtime paths, even when no bounded scope was configured", () => {
    const controlRoot = temporaryDirectory("control-");
    fs.mkdirSync(path.join(controlRoot, ".mimocode"), { recursive: true });
    fs.writeFileSync(path.join(controlRoot, ".mimocode", ".cron-lock"), "control\n");
    const prepared = prepare(controlRoot);
    fs.writeFileSync(path.join(prepared.executionRoot, ".mimocode", ".cron-lock"), "execution\n");
    fs.mkdirSync(path.join(prepared.executionRoot, ".codex-mimo"), { recursive: true });
    fs.writeFileSync(path.join(prepared.executionRoot, ".codex-mimo", "runtime.txt"), "runtime\n");

    const plan = createWorkspacePromotionPlan({
      baseline: prepared.baseline,
      executionRoot: prepared.executionRoot
    });
    expect(plan.operations).toEqual([]);
    const result = applyWorkspacePromotion({ ...prepared, controlRoot, plan });
    expect(result.passed).toBe(true);
    expect(fs.readFileSync(path.join(controlRoot, ".mimocode", ".cron-lock"), "utf8")).toBe("control\n");
  });

  it("promotes deletion and binary replacement while retaining a recoverable backup", () => {
    const controlRoot = temporaryDirectory("control-");
    fs.mkdirSync(path.join(controlRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(controlRoot, "src", "remove.txt"), "remove me");
    fs.writeFileSync(path.join(controlRoot, "src", "data.bin"), Buffer.from([1, 2, 3]));
    const prepared = prepare(controlRoot);
    fs.rmSync(path.join(prepared.executionRoot, "src", "remove.txt"));
    fs.writeFileSync(path.join(prepared.executionRoot, "src", "data.bin"), Buffer.from([255, 0, 128]));

    const plan = createWorkspacePromotionPlan({
      baseline: prepared.baseline,
      executionRoot: prepared.executionRoot,
      allowedPaths: ["src/**"]
    });
    expect(plan.operations.map((operation) => `${operation.kind}:${operation.path}`))
      .toEqual(["delete:src/remove.txt", "upsert_file:src/data.bin"]);
    const result = applyWorkspacePromotion({ ...prepared, controlRoot, plan });
    expect(result.passed).toBe(true);
    expect(fs.existsSync(path.join(controlRoot, "src", "remove.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(controlRoot, "src", "data.bin"))).toEqual(Buffer.from([255, 0, 128]));
    expect(fs.existsSync(path.join(path.dirname(result.journalPath!), `${path.basename(result.journalPath!, ".json")}.backup`, "src", "remove.txt"))).toBe(true);
  });

  it("detects a concurrent control-tree change before writing anything", () => {
    const controlRoot = temporaryDirectory("control-");
    fs.mkdirSync(path.join(controlRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(controlRoot, "src", "app.ts"), "baseline\n");
    const prepared = prepare(controlRoot);
    fs.writeFileSync(path.join(prepared.executionRoot, "src", "app.ts"), "execution\n");
    const plan = createWorkspacePromotionPlan({
      baseline: prepared.baseline,
      executionRoot: prepared.executionRoot,
      allowedPaths: ["src/**"]
    });
    fs.writeFileSync(path.join(controlRoot, "src", "app.ts"), "user edit\n");

    const result = applyWorkspacePromotion({ ...prepared, controlRoot, plan });
    expect(result).toMatchObject({ passed: false, failureCode: "promotion_conflict", conflictPaths: ["src/app.ts"] });
    expect(fs.readFileSync(path.join(controlRoot, "src", "app.ts"), "utf8")).toBe("user edit\n");
  });

  it("blocks a directory deletion when a user adds a child during execution", () => {
    const controlRoot = temporaryDirectory("control-");
    fs.mkdirSync(path.join(controlRoot, "allowed"), { recursive: true });
    fs.writeFileSync(path.join(controlRoot, "allowed", "baseline.txt"), "baseline\n");
    const prepared = prepare(controlRoot);
    fs.rmSync(path.join(prepared.executionRoot, "allowed"), { recursive: true });
    const plan = createWorkspacePromotionPlan({ baseline: prepared.baseline, executionRoot: prepared.executionRoot, allowedPaths: ["allowed/**"] });
    fs.writeFileSync(path.join(controlRoot, "allowed", "user.txt"), "keep me\n");

    const result = applyWorkspacePromotion({ ...prepared, controlRoot, plan });
    expect(result).toMatchObject({ passed: false, failureCode: "promotion_conflict" });
    expect(result.conflictPaths).toContain("allowed/user.txt");
    expect(fs.readFileSync(path.join(controlRoot, "allowed", "user.txt"), "utf8")).toBe("keep me\n");
  });

  it("blocks a directory-to-file replacement when a user changes a child", () => {
    const controlRoot = temporaryDirectory("control-");
    fs.mkdirSync(path.join(controlRoot, "allowed"), { recursive: true });
    fs.writeFileSync(path.join(controlRoot, "allowed", "baseline.txt"), "baseline\n");
    const prepared = prepare(controlRoot);
    fs.rmSync(path.join(prepared.executionRoot, "allowed"), { recursive: true });
    fs.writeFileSync(path.join(prepared.executionRoot, "allowed"), "replacement\n");
    const plan = createWorkspacePromotionPlan({ baseline: prepared.baseline, executionRoot: prepared.executionRoot, allowedPaths: ["allowed", "allowed/**"] });
    fs.writeFileSync(path.join(controlRoot, "allowed", "baseline.txt"), "user edit\n");

    const result = applyWorkspacePromotion({ ...prepared, controlRoot, plan });
    expect(result).toMatchObject({ passed: false, failureCode: "promotion_conflict" });
    expect(result.conflictPaths).toContain("allowed/baseline.txt");
    expect(fs.readFileSync(path.join(controlRoot, "allowed", "baseline.txt"), "utf8")).toBe("user edit\n");
  });

  it("promotes a newly-created empty directory", () => {
    const controlRoot = temporaryDirectory("control-");
    const prepared = prepare(controlRoot);
    fs.mkdirSync(path.join(prepared.executionRoot, "generated"));
    const plan = createWorkspacePromotionPlan({ baseline: prepared.baseline, executionRoot: prepared.executionRoot, allowedPaths: ["generated", "generated/**"] });

    expect(plan.operations).toEqual([{ kind: "mkdir", path: "generated" }]);
    expect(applyWorkspacePromotion({ ...prepared, controlRoot, plan }).passed).toBe(true);
    expect(fs.lstatSync(path.join(controlRoot, "generated")).isDirectory()).toBe(true);
  });

  it("treats an omitted scope as unrestricted and an explicit empty scope as deny-all", () => {
    const unrestrictedControl = temporaryDirectory("control-");
    fs.mkdirSync(path.join(unrestrictedControl, "src"), { recursive: true });
    const unrestricted = prepare(unrestrictedControl);
    fs.writeFileSync(path.join(unrestricted.executionRoot, "src", "app.ts"), "new\n");
    expect(createWorkspacePromotionPlan({
      baseline: unrestricted.baseline,
      executionRoot: unrestricted.executionRoot
    }).passed).toBe(true);

    const restrictedControl = temporaryDirectory("control-");
    fs.mkdirSync(path.join(restrictedControl, "src"), { recursive: true });
    const restricted = prepare(restrictedControl);
    fs.writeFileSync(path.join(restricted.executionRoot, "src", "app.ts"), "new\n");
    expect(createWorkspacePromotionPlan({
      baseline: restricted.baseline,
      executionRoot: restricted.executionRoot,
      allowedPaths: []
    })).toMatchObject({ passed: false, failureCode: "promotion_scope_violation" });
  });

  it("orders directory-to-file and file-to-directory replacements safely", () => {
    const controlRoot = temporaryDirectory("control-");
    fs.mkdirSync(path.join(controlRoot, "directory"), { recursive: true });
    fs.writeFileSync(path.join(controlRoot, "directory", "child.txt"), "old\n");
    fs.writeFileSync(path.join(controlRoot, "file"), "old\n");
    const prepared = prepare(controlRoot);
    fs.rmSync(path.join(prepared.executionRoot, "directory"), { recursive: true });
    fs.writeFileSync(path.join(prepared.executionRoot, "directory"), "new file\n");
    fs.rmSync(path.join(prepared.executionRoot, "file"));
    fs.mkdirSync(path.join(prepared.executionRoot, "file"));
    fs.writeFileSync(path.join(prepared.executionRoot, "file", "child.txt"), "new child\n");
    const plan = createWorkspacePromotionPlan({ baseline: prepared.baseline, executionRoot: prepared.executionRoot, allowedPaths: ["directory", "directory/**", "file", "file/**"] });

    const result = applyWorkspacePromotion({ ...prepared, controlRoot, plan });
    expect(result.passed).toBe(true);
    expect(fs.readFileSync(path.join(controlRoot, "directory"), "utf8")).toBe("new file\n");
    expect(fs.readFileSync(path.join(controlRoot, "file", "child.txt"), "utf8")).toBe("new child\n");
  });

  it("uses the original control target for rewritten absolute execution symlinks", () => {
    const controlRoot = temporaryDirectory("control-");
    fs.mkdirSync(path.join(controlRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(controlRoot, "src", "target.txt"), "target\n");
    const prepared = prepare(controlRoot);
    const target = path.join(prepared.executionRoot, "src", "target.txt");
    fs.symlinkSync(target, path.join(prepared.executionRoot, "src", "link.txt"));
    const plan = createWorkspacePromotionPlan({ baseline: prepared.baseline, executionRoot: prepared.executionRoot, allowedPaths: ["src/**"] });

    expect(applyWorkspacePromotion({ ...prepared, controlRoot, plan }).passed).toBe(true);
    expect(fs.readlinkSync(path.join(controlRoot, "src", "link.txt"))).toBe(path.join(controlRoot, "src", "target.txt"));
  });

  it("promotes a directory symlink when the platform permits it", () => {
    const controlRoot = temporaryDirectory("control-");
    fs.mkdirSync(path.join(controlRoot, "src"), { recursive: true });
    const prepared = prepare(controlRoot);
    fs.mkdirSync(path.join(prepared.executionRoot, "src", "target"));
    try {
      fs.symlinkSync("target", path.join(prepared.executionRoot, "src", "link"), process.platform === "win32" ? "junction" : undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") return;
      throw error;
    }
    const plan = createWorkspacePromotionPlan({ baseline: prepared.baseline, executionRoot: prepared.executionRoot, allowedPaths: ["src/**"] });

    expect(applyWorkspacePromotion({ ...prepared, controlRoot, plan }).passed).toBe(true);
    expect(fs.statSync(path.join(controlRoot, "src", "link")).isDirectory()).toBe(true);
  });

  it("rejects a forged root promotion operation without touching the workspace root", () => {
    const controlRoot = temporaryDirectory("control-");
    fs.writeFileSync(path.join(controlRoot, "keep.txt"), "keep\n");
    const prepared = prepare(controlRoot);
    const result = applyWorkspacePromotion({
      ...prepared,
      controlRoot,
      plan: { passed: true, operations: [{ kind: "delete", path: "." }], artifactFiles: [], outOfScopePaths: [] }
    });

    expect(result).toMatchObject({ passed: false, failureCode: "promotion_apply_failed" });
    expect(fs.readFileSync(path.join(controlRoot, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("rolls back a new file when recording its write intent fails", () => {
    const controlRoot = temporaryDirectory("control-");
    fs.mkdirSync(path.join(controlRoot, "src"), { recursive: true });
    const prepared = prepare(controlRoot);
    fs.writeFileSync(path.join(prepared.executionRoot, "src", "new.ts"), "new\n");
    const plan = createWorkspacePromotionPlan({ baseline: prepared.baseline, executionRoot: prepared.executionRoot, allowedPaths: ["src/**"] });
    const writeFileSync = fs.writeFileSync.bind(fs);
    let journalWrites = 0;
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (String(file).includes("promotion-journal")) {
        journalWrites += 1;
        if (journalWrites === 3) throw new Error("journal write failed");
      }
      return writeFileSync(file, data, options as never);
    });
    try {
      const result = applyWorkspacePromotion({ ...prepared, controlRoot, plan });
      expect(result).toMatchObject({ passed: false, failureCode: "promotion_apply_failed" });
    } finally {
      writeSpy.mockRestore();
    }
    expect(fs.existsSync(path.join(controlRoot, "src", "new.ts"))).toBe(false);
  });

  it("does not remove a user edit that races with rollback", () => {
    const controlRoot = temporaryDirectory("control-");
    fs.mkdirSync(path.join(controlRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(controlRoot, "src", "first.ts"), "baseline\n");
    const prepared = prepare(controlRoot);
    fs.writeFileSync(path.join(prepared.executionRoot, "src", "first.ts"), "execution\n");
    fs.writeFileSync(path.join(prepared.executionRoot, "src", "second.ts"), "execution\n");
    const plan = createWorkspacePromotionPlan({ baseline: prepared.baseline, executionRoot: prepared.executionRoot, allowedPaths: ["src/**"] });
    const writeFileSync = fs.writeFileSync.bind(fs);
    let journalWrites = 0;
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (String(file).includes("promotion-journal")) {
        journalWrites += 1;
        if (journalWrites === 4) {
          writeFileSync(path.join(controlRoot, "src", "first.ts"), "user edit\n", "utf8");
          throw new Error("journal write failed");
        }
      }
      return writeFileSync(file, data, options as never);
    });
    try {
      expect(applyWorkspacePromotion({ ...prepared, controlRoot, plan }).passed).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }
    expect(fs.readFileSync(path.join(controlRoot, "src", "first.ts"), "utf8")).toBe("user edit\n");
  });
});

function prepare(controlRoot: string) {
  const executionRoot = path.join(temporaryDirectory("execution-parent-"), "workspace");
  return prepareExecutionWorkspace({ sourceRoot: controlRoot, executionRoot });
}

function temporaryDirectory(prefix: string): string {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `codex-mimo-${prefix}`));
  temporaryRoots.push(temporaryRoot);
  return temporaryRoot;
}
