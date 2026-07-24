import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withUtf8ProcessEnv } from "./encoding.js";
import { errorMessage } from "./errors.js";
import { resolveJobDir, resolveJobPaths } from "./job-store.js";

export function resolveJobWorkerOwnershipKey(cwd: string, jobId: string): string {
  return `${resolveJobPaths(cwd, jobId).jobFile}.worker-ownership`;
}

export function resolveNotificationWorkerOwnershipKey(cwd: string): string {
  return path.join(resolveJobDir(cwd), "notification-worker-ownership");
}

export type WorkerCommand = "job-supervisor" | "job-worker" | "notify-worker";

export type ProcessIdentityCapture =
  | { status: "running"; identity: string; evidence: string }
  | { status: "not_running"; evidence: string }
  | { status: "unconfirmed"; evidence: string };

export type ProcessIdentityVerification =
  | { status: "match"; evidence: string }
  | { status: "identity_mismatch"; actualIdentity: string; evidence: string }
  | { status: "not_running"; evidence: string }
  | { status: "unconfirmed"; evidence: string };

export type OwnedProcessTermination =
  | { status: "terminated" | "not_running" | "identity_mismatch"; evidence: string }
  | { status: "unconfirmed"; evidence: string };

export type ProcessGroupProbe =
  | { status: "running" | "not_running"; evidence: string }
  | { status: "unconfirmed"; evidence: string };

export type ProcessGroupSignal = "SIGTERM" | "SIGKILL";

export type ProcessGroupSignalResult =
  | { status: "sent"; evidence: string }
  | { status: "not_running"; evidence: string }
  | { status: "unconfirmed"; evidence: string };

export interface ProcessGroupTerminationOptions {
  signalProcessGroup?: (
    pid: number,
    signal: ProcessGroupSignal
  ) => ProcessGroupSignalResult;
  probeProcessGroup?: (pid: number) => ProcessGroupProbe;
  wait?: (milliseconds: number) => void;
  graceChecks?: number;
  graceIntervalMs?: number;
  killProcess?: (pid: number, signal?: string) => unknown;
}

export interface AsyncProcessGroupTerminationOptions {
  signalProcessGroup?: (
    pid: number,
    signal: ProcessGroupSignal
  ) => ProcessGroupSignalResult | PromiseLike<ProcessGroupSignalResult>;
  probeProcessGroup?: (pid: number) => ProcessGroupProbe | PromiseLike<ProcessGroupProbe>;
  wait?: (milliseconds: number) => void | PromiseLike<void>;
  graceChecks?: number;
  graceIntervalMs?: number;
  killProcess?: (pid: number, signal?: string) => unknown;
}

export interface ProcessIdentityCaptureOptions {
  query?: (pid: number) => ProcessIdentityCapture;
  platform?: NodeJS.Platform;
  readFile?: typeof fs.readFileSync;
  spawnSync?: typeof spawnSync;
}

export interface OwnedProcessTerminationOptions {
  captureIdentity?: (pid: number) => ProcessIdentityCapture;
  killProcessTree?: (pid: number) => { ok: boolean; evidence: string };
  signalProcessGroup?: (
    pid: number,
    signal: ProcessGroupSignal
  ) => ProcessGroupSignalResult;
  probeProcessGroup?: (pid: number) => ProcessGroupProbe;
  wait?: (milliseconds: number) => void;
  graceChecks?: number;
  graceIntervalMs?: number;
  platform?: NodeJS.Platform;
  killProcess?: (pid: number, signal?: string) => unknown;
  spawnSync?: typeof spawnSync;
}

export function resolveCliEntrypoint(moduleUrl = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "cli", "main.js");
}

export function spawnWorker(command: WorkerCommand, cwd: string, jobId?: string): number {
  const args = [resolveCliEntrypoint(), command, "--cwd", cwd];
  if (jobId) args.push("--job-id", jobId);
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: withUtf8ProcessEnv()
  });
  child.unref();
  return child.pid ?? 0;
}

export function spawnJobWorker(cwd: string, jobId: string): number {
  return spawnWorker("job-worker", cwd, jobId);
}

export function spawnJobSupervisor(cwd: string): number {
  return spawnWorker("job-supervisor", cwd);
}

export function spawnNotificationWorker(cwd: string): number {
  return spawnWorker("notify-worker", cwd);
}

export function captureProcessIdentity(
  pid: number | null | undefined,
  options: ProcessIdentityCaptureOptions = {}
): ProcessIdentityCapture {
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    return { status: "unconfirmed", evidence: "Process PID is missing or invalid." };
  }
  if (options.query) return options.query(pid as number);
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return captureWindowsIdentity(pid as number, options.spawnSync ?? spawnSync);
  }
  if (platform === "linux") {
    return captureLinuxIdentity(pid as number, options.readFile ?? fs.readFileSync);
  }
  if (platform === "darwin") {
    return capturePosixIdentity(pid as number, platform, options.spawnSync ?? spawnSync);
  }
  return {
    status: "unconfirmed",
    evidence: `Process identity is unsupported on platform ${platform}.`
  };
}

export function verifyProcessIdentity(
  pid: number | null | undefined,
  expectedIdentity: string | null | undefined,
  options: { captureIdentity?: (pid: number) => ProcessIdentityCapture } = {}
): ProcessIdentityVerification {
  if (!Number.isInteger(pid) || (pid as number) <= 0 || !expectedIdentity) {
    return { status: "unconfirmed", evidence: "Stored PID or process identity is missing." };
  }
  const captured = (options.captureIdentity ?? captureProcessIdentity)(pid as number);
  if (captured.status !== "running") return captured;
  if (captured.identity !== expectedIdentity) {
    return {
      status: "identity_mismatch",
      actualIdentity: captured.identity,
      evidence: captured.evidence
    };
  }
  return { status: "match", evidence: captured.evidence };
}

export function terminateOwnedJobProcess(
  pid: number | null | undefined,
  expectedIdentity: string | null | undefined,
  options: OwnedProcessTerminationOptions = {}
): OwnedProcessTermination {
  const captureIdentity = options.captureIdentity ?? captureProcessIdentity;
  const verification = verifyProcessIdentity(pid, expectedIdentity, { captureIdentity });
  if (verification.status !== "match") return verification;

  const platform = options.platform ?? process.platform;
  if (platform === "linux" || platform === "darwin") {
    return terminatePosixProcessGroupSync(pid as number, options);
  }
  if (platform !== "win32") {
    return {
      status: "unconfirmed",
      evidence: `Owned process termination is unsupported on platform ${platform}.`
    };
  }

  const killProcessTree = options.killProcessTree ?? ((targetPid: number) =>
    killWindowsTreeWithEvidence(targetPid, options));
  const killed = killProcessTree(pid as number);
  if (!killed.ok) return { status: "unconfirmed", evidence: killed.evidence };

  const after = captureIdentity(pid as number);
  if (after.status === "not_running") return { status: "terminated", evidence: after.evidence };
  if (after.status === "running" && after.identity !== expectedIdentity) {
    return {
      status: "terminated",
      evidence: `Original process exited; PID was reused (${after.evidence}).`
    };
  }
  return { status: "unconfirmed", evidence: after.evidence };
}

function captureLinuxIdentity(pid: number, readFile: typeof fs.readFileSync): ProcessIdentityCapture {
  try {
    const stat = String(readFile(`/proc/${pid}/stat`, "utf8"));
    const endCommand = stat.lastIndexOf(")");
    const fields = endCommand >= 0 ? stat.slice(endCommand + 1).trim().split(/\s+/) : [];
    const startTicks = fields[19];
    if (!startTicks) return { status: "unconfirmed", evidence: "Malformed Linux process stat." };
    const bootId = String(readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (!bootId) return { status: "unconfirmed", evidence: "Linux boot identity is unavailable." };
    return {
      status: "running",
      identity: `linux:${bootId}:${startTicks}`,
      evidence: `Linux process start tick ${startTicks}.`
    };
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT") || isErrorWithCode(error, "ESRCH")) {
      return { status: "not_running", evidence: `PID ${pid} is not running.` };
    }
    return { status: "unconfirmed", evidence: `Linux identity query failed: ${errorMessage(error)}` };
  }
}

function captureWindowsIdentity(pid: number, run: typeof spawnSync): ProcessIdentityCapture {
  const command = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; ` +
    `if ($null -eq $p) { exit 3 }; $p.CreationDate.ToUniversalTime().Ticks`;
  try {
    const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000
    });
    if (result.status === 3) return { status: "not_running", evidence: `PID ${pid} is not running.` };
    if (result.error || result.status !== 0) {
      return {
        status: "unconfirmed",
        evidence: `Windows identity query failed: ${result.error?.message ?? String(result.stderr).trim()}`
      };
    }
    const ticks = String(result.stdout).trim();
    if (!/^\d+$/.test(ticks)) {
      return { status: "unconfirmed", evidence: "Windows process creation time is unavailable." };
    }
    return {
      status: "running",
      identity: `win32:${ticks}`,
      evidence: `Windows process creation ticks ${ticks}.`
    };
  } catch (error) {
    return { status: "unconfirmed", evidence: `Windows identity query failed: ${errorMessage(error)}` };
  }
}

function capturePosixIdentity(
  pid: number,
  platform: NodeJS.Platform,
  run: typeof spawnSync
): ProcessIdentityCapture {
  try {
    const result = run("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    if (result.status === 1) return { status: "not_running", evidence: `PID ${pid} is not running.` };
    const startedAt = String(result.stdout).trim();
    if (result.error || result.status !== 0 || !startedAt) {
      return { status: "unconfirmed", evidence: `POSIX identity query failed for PID ${pid}.` };
    }
    return {
      status: "running",
      identity: `${platform}:${startedAt}`,
      evidence: `POSIX process start time ${startedAt}.`
    };
  } catch (error) {
    return { status: "unconfirmed", evidence: `POSIX identity query failed: ${errorMessage(error)}` };
  }
}

export function terminatePosixProcessGroupSync(
  pid: number,
  options: ProcessGroupTerminationOptions = {}
): OwnedProcessTermination {
  const signalGroup = options.signalProcessGroup ?? ((targetPid, signal) =>
    signalPosixProcessGroup(targetPid, signal, options.killProcess));
  const probeGroup = options.probeProcessGroup ?? probePosixProcessGroup;
  const wait = options.wait ?? waitSynchronously;
  const checks = positiveIntegerOr(options.graceChecks, 3);
  const intervalMs = nonNegativeNumberOr(options.graceIntervalMs, 50);

  return driveProcessGroupTermination(
    createProcessGroupTermination(pid, checks, intervalMs),
    (step) => executeProcessGroupStep(step, signalGroup, probeGroup, wait) as ProcessGroupTerminationStepResult
  );
}

export async function terminatePosixProcessGroup(
  pid: number,
  options: AsyncProcessGroupTerminationOptions = {}
): Promise<OwnedProcessTermination> {
  const signalGroup = options.signalProcessGroup ?? ((targetPid, signal) =>
    signalPosixProcessGroup(targetPid, signal, options.killProcess));
  const probeGroup = options.probeProcessGroup ?? probePosixProcessGroup;
  const wait = options.wait ?? waitAsynchronously;
  const checks = positiveIntegerOr(options.graceChecks, 3);
  const intervalMs = nonNegativeNumberOr(options.graceIntervalMs, 50);
  const sequence = createProcessGroupTermination(pid, checks, intervalMs);
  let next = sequence.next();
  while (!next.done) {
    try {
      next = sequence.next(await executeProcessGroupStep(next.value, signalGroup, probeGroup, wait));
    } catch (error) {
      next = sequence.next({
        status: "unconfirmed",
        evidence: `Process-group operation failed: ${errorMessage(error)}`
      });
    }
  }
  return next.value;
}

type ProcessGroupTerminationStep =
  | { type: "signal"; pid: number; signal: ProcessGroupSignal }
  | { type: "probe"; pid: number }
  | { type: "wait"; milliseconds: number };

type ProcessGroupTerminationStepResult = ProcessGroupSignalResult | ProcessGroupProbe | void;

function* createProcessGroupTermination(
  pid: number,
  checks: number,
  intervalMs: number
): Generator<ProcessGroupTerminationStep, OwnedProcessTermination, ProcessGroupTerminationStepResult> {
  const afterTermSignal = yield { type: "signal", pid, signal: "SIGTERM" };
  if (isGroupGone(afterTermSignal)) return terminatedGroup(afterTermSignal.evidence);
  if (!isSignalSent(afterTermSignal)) return unconfirmedGroup(afterTermSignal);

  const afterTerm = yield* probeProcessGroupExit(pid, checks, intervalMs);
  if (afterTerm.status === "not_running") return terminatedGroup(afterTerm.evidence);
  if (afterTerm.status === "unconfirmed") return afterTerm;

  const afterKillSignal = yield { type: "signal", pid, signal: "SIGKILL" };
  if (isGroupGone(afterKillSignal)) return terminatedGroup(afterKillSignal.evidence);
  if (!isSignalSent(afterKillSignal)) return unconfirmedGroup(afterKillSignal);

  const afterKill = yield* probeProcessGroupExit(pid, checks, intervalMs);
  return afterKill.status === "not_running"
    ? terminatedGroup(afterKill.evidence)
    : { status: "unconfirmed", evidence: afterKill.evidence };
}

function* probeProcessGroupExit(
  pid: number,
  checks: number,
  intervalMs: number
): Generator<ProcessGroupTerminationStep, ProcessGroupProbe, ProcessGroupTerminationStepResult> {
  let lastRunning: ProcessGroupProbe = {
    status: "running",
    evidence: `Process group ${pid} is still running.`
  };
  for (let check = 0; check < checks; check += 1) {
    const result = yield { type: "probe", pid };
    if (!isProcessGroupProbe(result)) {
      return { status: "unconfirmed", evidence: "Process-group probe returned no result." };
    }
    if (result.status !== "running") return result;
    lastRunning = result;
    if (check < checks - 1) {
      const waited = yield { type: "wait", milliseconds: intervalMs };
      if (isUnconfirmedResult(waited)) return waited;
    }
  }
  return lastRunning;
}

function driveProcessGroupTermination(
  sequence: Generator<ProcessGroupTerminationStep, OwnedProcessTermination, ProcessGroupTerminationStepResult>,
  execute: (step: ProcessGroupTerminationStep) => ProcessGroupTerminationStepResult
): OwnedProcessTermination {
  let next = sequence.next();
  while (!next.done) {
    try {
      next = sequence.next(execute(next.value));
    } catch (error) {
      next = sequence.next({
        status: "unconfirmed",
        evidence: `Process-group operation failed: ${errorMessage(error)}`
      });
    }
  }
  return next.value;
}

function executeProcessGroupStep(
  step: ProcessGroupTerminationStep,
  signal: (pid: number, signal: ProcessGroupSignal) => ProcessGroupSignalResult | PromiseLike<ProcessGroupSignalResult>,
  probe: (pid: number) => ProcessGroupProbe | PromiseLike<ProcessGroupProbe>,
  wait: (milliseconds: number) => void | PromiseLike<void>
): ProcessGroupTerminationStepResult | PromiseLike<ProcessGroupTerminationStepResult> {
  if (step.type === "signal") return signal(step.pid, step.signal);
  if (step.type === "probe") return probe(step.pid);
  return wait(step.milliseconds);
}

function signalPosixProcessGroup(
  pid: number,
  signal: ProcessGroupSignal,
  killProcess: (targetPid: number, targetSignal?: string) => unknown =
    (targetPid, targetSignal) => process.kill(targetPid, targetSignal)
): ProcessGroupSignalResult {
  try {
    killProcess(-pid, signal);
    return { status: "sent", evidence: `${signal} sent to process group ${pid}.` };
  } catch (error) {
    if (isErrorWithCode(error, "ESRCH")) {
      return {
        status: "not_running",
        evidence: `Process group ${pid} exited before ${signal}.`
      };
    }
    return {
      status: "unconfirmed",
      evidence: `${signal} failed for process group ${pid}: ${errorMessage(error)}`
    };
  }
}

function probePosixProcessGroup(pid: number): ProcessGroupProbe {
  try {
    process.kill(-pid, 0);
    return { status: "running", evidence: `Process group ${pid} is running.` };
  } catch (error) {
    if (isErrorWithCode(error, "ESRCH")) {
      return { status: "not_running", evidence: `Process group ${pid} is not running.` };
    }
    return {
      status: "unconfirmed",
      evidence: `Process-group probe failed for ${pid}: ${errorMessage(error)}`
    };
  }
}

function waitSynchronously(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitAsynchronously(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isGroupGone(
  result: ProcessGroupTerminationStepResult
): result is Extract<ProcessGroupSignalResult, { status: "not_running" }> {
  return isProcessGroupResult(result) && result.status === "not_running";
}

function isSignalSent(
  result: ProcessGroupTerminationStepResult
): result is Extract<ProcessGroupSignalResult, { status: "sent" }> {
  return isProcessGroupResult(result) && result.status === "sent";
}

function isProcessGroupProbe(result: ProcessGroupTerminationStepResult): result is ProcessGroupProbe {
  return isProcessGroupResult(result) && result.status !== "sent";
}

function isProcessGroupResult(
  result: ProcessGroupTerminationStepResult
): result is ProcessGroupSignalResult | ProcessGroupProbe {
  return typeof result === "object" && result !== null && "status" in result && "evidence" in result;
}

function isUnconfirmedResult(
  result: ProcessGroupTerminationStepResult
): result is Extract<ProcessGroupSignalResult | ProcessGroupProbe, { status: "unconfirmed" }> {
  return isProcessGroupResult(result) && result.status === "unconfirmed";
}

function terminatedGroup(evidence: string): OwnedProcessTermination {
  return { status: "terminated", evidence };
}

function unconfirmedGroup(result: ProcessGroupTerminationStepResult): OwnedProcessTermination {
  return {
    status: "unconfirmed",
    evidence: isProcessGroupResult(result) ? result.evidence : "Process-group signal returned no result."
  };
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function nonNegativeNumberOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function killWindowsTreeWithEvidence(
  pid: number,
  options: Pick<OwnedProcessTerminationOptions, "spawnSync">
): { ok: boolean; evidence: string } {
  try {
    const result = (options.spawnSync ?? spawnSync)("taskkill", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true
    });
    if (result.error || result.status !== 0) {
      return {
        ok: false,
        evidence: `taskkill failed: ${result.error?.message ?? String(result.stderr).trim()}`
      };
    }
    return { ok: true, evidence: `taskkill accepted PID ${pid}.` };
  } catch (error) {
    return { ok: false, evidence: `Process termination failed: ${errorMessage(error)}` };
  }
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
