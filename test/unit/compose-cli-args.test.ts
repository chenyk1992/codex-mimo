import { expect, it, vi } from "vitest";
import { runCli, type CliDependencies } from "../../src/cli/commands.js";

it("passes the complete Compose request through the shared work API", async () => {
  const mimoCompose = vi.fn(async () => ({ jobId: "job-compose", kind: "compose", status: "queued" }));
  const stderr: string[] = [];
  const exitCode = await runCli([
    "compose",
    "--cwd", "E:/project",
    "--workflow", "fix-ci",
    "--file", "ci.log",
    "--since", "origin/main",
    "--verify", "npm test",
    "--verify", "npm run build",
    "--report-dir", "reports",
    "--model", "mimo-v2",
    "--timeout-ms", "45000",
    "Fix the pipeline"
  ], {
    cwd: () => "E:/fallback",
    stdout: vi.fn(),
    stderr: (line) => stderr.push(line),
    mimoCompose
  } as CliDependencies);

  expect(exitCode).toBe(0);
  expect(stderr).toEqual([]);
  expect(mimoCompose).toHaveBeenCalledWith({
    cwd: "E:/project",
    workflow: "fix-ci",
    file: "ci.log",
    since: "origin/main",
    verification: ["npm test", "npm run build"],
    reportDir: "reports",
    model: "mimo-v2",
    timeoutMs: 45000,
    task: "Fix the pipeline"
  });
});

it("rejects Compose-only legacy execution flags", async () => {
  for (const flag of ["--background", "--wait", "--attach", "--fork", "--continue", "--dry-run"]) {
    const stderr: string[] = [];
    const exitCode = await runCli(["compose", "--workflow", "dev", "Task", flag], {
      cwd: () => "E:/project",
      stdout: vi.fn(),
      stderr: (line) => stderr.push(line),
      mimoCompose: vi.fn()
    } as unknown as CliDependencies);
    expect(exitCode).toBe(2);
    expect(stderr.join("\n")).toContain(flag);
  }
});

it.each([
  [["compose", "--workflow", "dev"], /requires a task/i],
  [["compose", "--workflow", "fix-ci"], /requires.*file/i]
] as const)("rejects invalid workflow-specific Compose input before launch", async (args, error) => {
  const mimoCompose = vi.fn();
  const stderr: string[] = [];
  const exitCode = await runCli(args, {
    cwd: () => "E:/project",
    stdout: vi.fn(),
    stderr: (line) => stderr.push(line),
    mimoCompose
  });

  expect(exitCode).toBe(2);
  expect(stderr.join("\n")).toMatch(error);
  expect(mimoCompose).not.toHaveBeenCalled();
});
