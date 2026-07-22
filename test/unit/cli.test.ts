import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_USAGE, runCli, type CliDependencies } from "../../src/cli/commands.js";

const cwd = "E:/project";
const jobId = "job-1";

function receipt(kind: string) {
  return {
    jobId,
    kind,
    status: "queued",
    actions: {
      status: "mimo_status",
      events: "mimo_events",
      result: "mimo_result",
      cancel: "mimo_cancel"
    }
  };
}

function dependencies(): CliDependencies {
  return {
    cwd: () => cwd,
    mimoPlan: vi.fn(async () => receipt("plan")),
    mimoImplement: vi.fn(async () => receipt("implement")),
    mimoReview: vi.fn(async () => receipt("review")),
    mimoFixCi: vi.fn(async () => receipt("fix-ci")),
    mimoResume: vi.fn(async () => receipt("resume")),
    mimoCompose: vi.fn(async () => receipt("compose")),
    mimoStatus: vi.fn(async () => ({ jobId, status: "running" })),
    mimoEvents: vi.fn(async () => ({ jobId, signals: [], nextCursor: 0 })),
    mimoWait: vi.fn(async () => ({ jobId, signals: [], timedOut: true })),
    mimoResult: vi.fn(async () => ({ jobId, status: "completed" })),
    mimoCancel: vi.fn(async () => ({ jobId, status: "cancelled" })),
    mimoJobs: vi.fn(async () => [{ jobId, status: "completed" }]),
    mimoHealthcheck: vi.fn(async () => ({ ok: true, version: "1.0.0", cwd })),
    runDoctor: vi.fn(async () => ({ ok: true } as never)),
    formatDoctorReport: vi.fn(() => "Doctor: ok"),
    runJobWorker: vi.fn(async () => undefined),
    runNotificationWorker: vi.fn(async () => undefined)
  };
}

async function invoke(args: string[], overrides: Partial<CliDependencies> = {}) {
  const deps = { ...dependencies(), ...overrides };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(args, {
    ...deps,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n"), deps };
}

async function invokeReal(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(args, {
    cwd: () => cwd,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("unified CLI work commands", () => {
  const cases = [
    ["plan", ["plan", "--cwd", cwd, "Plan authentication"], "mimoPlan",
      { cwd, task: "Plan authentication" }],
    ["implement", ["implement", "--cwd", cwd, "--allow-write", "Implement authentication"], "mimoImplement",
      { cwd, task: "Implement authentication", allowWrite: true }],
    ["review", ["review", "--cwd", cwd, "--base", "origin/main"], "mimoReview",
      { cwd, base: "origin/main" }],
    ["fix-ci", ["fix-ci", "--cwd", cwd, "--file", "ci.log", "Fix CI"], "mimoFixCi",
      { cwd, file: "ci.log", task: "Fix CI" }],
    ["resume", ["resume", "--cwd", cwd, "--job-id", "parent-1", "Continue implementation"], "mimoResume",
      { cwd, jobId: "parent-1", task: "Continue implementation" }],
    ["compose", ["compose", "--cwd", cwd, "--workflow", "dev", "Build authentication"], "mimoCompose",
      { cwd, workflow: "dev", task: "Build authentication", timeoutMs: 1_800_000, idleTimeoutMs: 1_800_000 }]
  ] as const;

  it.each(cases)("%s prints a queued receipt", async (kind, args, dependency, expectedInput) => {
    const startedAt = performance.now();
    const result = await invoke([...args]);
    const elapsedMs = performance.now() - startedAt;

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind,
      status: "queued",
      actions: { result: "mimo_result" }
    });
    expect(result.stderr).toBe("");
    expect(elapsedMs).toBeLessThan(1_000);
    expect(result.deps[dependency]).toHaveBeenCalledWith(expectedInput);
  });

  it("parses common job options once for every work command", async () => {
    const result = await invoke([
      "plan", "Plan 中文支持", "--cwd", cwd, "--model", "mimo-v2",
      "--timeout-ms", "9000", "--notify", "codex", "--thread-id", "thread-1"
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.deps.mimoPlan).toHaveBeenCalledWith({
      cwd,
      task: "Plan 中文支持",
      model: "mimo-v2",
      timeoutMs: 9000,
      notify: { type: "codex", threadId: "thread-1" }
    });
  });

  it.each([
    [["--notify", "codex"], { type: "codex" }],
    [["--notify", "codex", "--thread-id", "thread-1"], { type: "codex", threadId: "thread-1" }],
    [["--notify", "webhook", "--url", "https://example.test/hook", "--secret-env", "HOOK_SECRET"],
      { type: "webhook", url: "https://example.test/hook", secretEnv: "HOOK_SECRET" }]
  ] as const)("supports notification variant %#", async (flags, notify) => {
    const result = await invoke(["plan", "Task", ...flags]);
    expect(result.exitCode).toBe(0);
    expect(result.deps.mimoPlan).toHaveBeenCalledWith(expect.objectContaining({ notify }));
  });

  it("requires explicit write authorization for implement", async () => {
    const result = await invoke(["implement", "Change code"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--allow-write");
    expect(result.deps.mimoImplement).not.toHaveBeenCalled();
  });

  it("requires --job-id rather than --session for resume", async () => {
    const missing = await invoke(["resume", "Continue"]);
    const legacy = await invoke(["resume", "--session", "session-1", "Continue"]);

    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("--job-id");
    expect(legacy.exitCode).toBe(2);
    expect(legacy.stderr).toContain("--session");
  });

  it("returns a stable runtime failure when job launch fails", async () => {
    const result = await invoke(["plan", "Task"], {
      mimoPlan: vi.fn(async () => { throw new Error("worker spawn failed"); })
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("worker spawn failed");
  });
});

describe("public CLI controls", () => {
  const cases = [
    ["status", ["status", "--cwd", cwd, "--job-id", jobId, "--json"], "mimoStatus"],
    ["events", ["events", "--cwd", cwd, "--job-id", jobId, "--since-cursor", "2", "--limit", "5", "--min-level", "warn", "--json"], "mimoEvents"],
    ["wait", ["wait", "--cwd", cwd, "--job-id", jobId, "--timeout-ms", "5", "--json"], "mimoWait"],
    ["result", ["result", "--cwd", cwd, "--job-id", jobId, "--json"], "mimoResult"],
    ["cancel", ["cancel", "--cwd", cwd, "--job-id", jobId, "--json"], "mimoCancel"],
    ["jobs", ["jobs", "--cwd", cwd, "--all", "--json"], "mimoJobs"]
  ] as const;

  it.each(cases)("supports %s", async (_command, args, dependency) => {
    const result = await invoke([...args]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toBeDefined();
    expect(result.deps[dependency]).toHaveBeenCalledTimes(1);
  });

  it("maps event and wait flags to the shared control input", async () => {
    const result = await invoke([
      "wait", "--job-id", jobId, "--since-cursor", "3", "--limit", "7",
      "--min-level", "error", "--timeout-ms", "12000"
    ]);
    expect(result.deps.mimoWait).toHaveBeenCalledWith({
      cwd,
      jobId,
      sinceCursor: 3,
      limit: 7,
      minLevel: "error",
      timeoutMs: 12000
    });
  });
});

describe("internal CLI workers", () => {
  it("runs job-worker without normal work output", async () => {
    const result = await invoke(["job-worker", "--cwd", cwd, "--job-id", jobId]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.deps.runJobWorker).toHaveBeenCalledWith(cwd, jobId);
  });

  it("runs notify-worker without normal work output", async () => {
    const result = await invoke(["notify-worker", "--cwd", cwd]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.deps.runNotificationWorker).toHaveBeenCalledWith(cwd);
  });
});

describe("strict CLI surface", () => {
  it.each(["compose-worker", "sessions"])("rejects removed %s command", async (command) => {
    const result = await invoke([command]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(`Unknown command: ${command}`);
  });

  it.each(["--background", "--wait", "--session", "--attach", "--fork", "--continue", "--dry-run"])(
    "rejects removed %s flag",
    async (flag) => {
      const result = await invoke(["plan", "Task", flag]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(flag);
    }
  );

  it("prints the exact canonical usage", async () => {
    const result = await invoke([]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(`Usage: ${CLI_USAGE}`);
    expect(CLI_USAGE).toBe(
      "codex-mimo <plan|implement|review|fix-ci|resume|compose|status|events|wait|result|cancel|jobs|doctor|healthcheck>"
    );
  });

  it("rejects malformed numeric flags as input errors", async () => {
    const result = await invoke(["plan", "Task", "--timeout-ms", "never"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--timeout-ms must be a positive integer");
  });
});

describe("shared input validation boundary", () => {
  it.each([
    [["compose", "--workflow", "bogus", "Task"], "workflow"],
    [["events", "--min-level", "trace"], "minLevel"],
    [["events", "--limit", "101"], "limit"]
  ] as const)("returns exit 2 for invalid shared input %#", async (args, field) => {
    const result = await invokeReal([...args]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(new RegExp(`^Invalid input: ${field}: `));
    expect(result.stderr).not.toContain("[\n  {");
  });

  it("returns exit 2 for a non-HTTP webhook URL", async () => {
    const result = await invokeReal([
      "plan", "Task", "--notify", "webhook", "--url", "file:///tmp/hook", "--secret-env", "HOOK_SECRET"
    ]);

    expect(result).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "Webhook URL must use http or https"
    });
  });

  it("keeps a shared job-not-found error as runtime exit 1", async () => {
    const result = await invokeReal(["status", "--job-id", "missing-job"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No jobs recorded");
  });
});
