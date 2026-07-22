import {
  mimoCancel as defaultMimoCancel,
  mimoCompose as defaultMimoCompose,
  mimoEvents as defaultMimoEvents,
  mimoFixCi as defaultMimoFixCi,
  mimoHealthcheck as defaultMimoHealthcheck,
  mimoImplement as defaultMimoImplement,
  mimoJobs as defaultMimoJobs,
  mimoPlan as defaultMimoPlan,
  mimoResult as defaultMimoResult,
  mimoResume as defaultMimoResume,
  mimoReview as defaultMimoReview,
  mimoStatus as defaultMimoStatus,
  mimoWait as defaultMimoWait
} from "../codex/tools.js";
import { runJobWorker as defaultRunJobWorker } from "../core/job-worker.js";
import { runJobSupervisor as defaultRunJobSupervisor } from "../core/job-supervisor.js";
import { formatZodError, InputValidationError } from "../core/input-validation.js";
import { runNotificationWorker as defaultRunNotificationWorker } from "../notify/worker.js";
import type { NotificationInput } from "../notify/types.js";
import { parseComposeInput } from "../codex/tool-schemas.js";
import { ZodError } from "zod";
import {
  formatDoctorReport as defaultFormatDoctorReport,
  runDoctor as defaultRunDoctor,
  type DoctorReport
} from "./doctor.js";
import { CLI_USAGE } from "./hints.js";

export { CLI_USAGE, DOCTOR_HINT } from "./hints.js";

type OutputWriter = (line: string) => void;
type AsyncCommand = (input: unknown) => Promise<unknown>;

export interface CliDependencies {
  cwd?: () => string;
  stdout?: OutputWriter;
  stderr?: OutputWriter;
  mimoPlan?: AsyncCommand;
  mimoImplement?: AsyncCommand;
  mimoReview?: AsyncCommand;
  mimoFixCi?: AsyncCommand;
  mimoResume?: AsyncCommand;
  mimoCompose?: AsyncCommand;
  mimoStatus?: AsyncCommand;
  mimoEvents?: AsyncCommand;
  mimoWait?: AsyncCommand;
  mimoResult?: AsyncCommand;
  mimoCancel?: AsyncCommand;
  mimoJobs?: AsyncCommand;
  mimoHealthcheck?: AsyncCommand;
  runDoctor?: (input: { cwd: string }) => Promise<DoctorReport>;
  formatDoctorReport?: (report: DoctorReport) => string;
  runJobWorker?: (cwd: string, jobId: string) => Promise<void>;
  runJobSupervisor?: (cwd: string) => Promise<void>;
  runNotificationWorker?: (cwd: string) => Promise<void>;
}

const WORK_COMMANDS = new Set(["plan", "implement", "review", "fix-ci", "resume", "compose"]);
const CONTROL_COMMANDS = new Set(["status", "events", "wait", "result", "cancel", "jobs"]);
const PUBLIC_COMMANDS = new Set([...WORK_COMMANDS, ...CONTROL_COMMANDS, "doctor", "healthcheck"]);
const INTERNAL_COMMANDS = new Set(["job-supervisor", "job-worker", "notify-worker"]);
const REMOVED_FLAGS = new Set([
  "--background", "--wait", "--session", "--attach", "--fork", "--continue", "--dry-run"
]);
const BOOLEAN_FLAGS = new Set(["--allow-write", "--all", "--json"]);
const VALUE_FLAGS = new Set([
  "--cwd", "--model", "--timeout-ms", "--idle-timeout-ms", "--notify", "--thread-id", "--url", "--secret-env",
  "--base", "--file", "--job-id", "--workflow", "--since", "--verify", "--report-dir",
  "--since-cursor", "--limit", "--min-level"
]);

export async function runCli(args: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const command = args[0];

  if (!command) {
    stderr(`Usage: ${CLI_USAGE}`);
    return 2;
  }
  if (!PUBLIC_COMMANDS.has(command) && !INTERNAL_COMMANDS.has(command)) {
    stderr(`Unknown command: ${command}`);
    return 2;
  }

  try {
    const parsed = parseArguments(args.slice(1));
    const cwd = parsed.takeValue("--cwd") ?? (dependencies.cwd ?? process.cwd)();
    const jsonOutput = parsed.takeBoolean("--json");

    if (INTERNAL_COMMANDS.has(command)) {
      if (jsonOutput) throw new CliInputError("--json is not supported by internal worker commands.");
      await runInternal(command, cwd, parsed, dependencies);
      return 0;
    }

    let result: unknown;
    if (WORK_COMMANDS.has(command)) {
      result = await runWork(command, cwd, parsed, dependencies);
    } else if (CONTROL_COMMANDS.has(command)) {
      result = await runControl(command, cwd, parsed, dependencies);
    } else if (command === "healthcheck") {
      parsed.assertConsumed();
      result = await (dependencies.mimoHealthcheck ?? defaultMimoHealthcheck)({ cwd });
      stdout(JSON.stringify(result));
      return isFailedHealthcheck(result) ? 1 : 0;
    } else {
      parsed.assertConsumed();
      const report = await (dependencies.runDoctor ?? defaultRunDoctor)({ cwd });
      stdout(jsonOutput
        ? JSON.stringify(report)
        : (dependencies.formatDoctorReport ?? defaultFormatDoctorReport)(report));
      return report.ok ? 0 : 1;
    }

    stdout(JSON.stringify(result));
    return 0;
  } catch (error) {
    if (error instanceof ZodError) {
      stderr(formatZodError(error));
      return 2;
    }
    stderr(errorMessage(error));
    return error instanceof InputValidationError ? 2 : 1;
  }
}

async function runWork(
  command: string,
  cwd: string,
  parsed: ParsedArguments,
  dependencies: CliDependencies
): Promise<unknown> {
  const common = parseJobOptions(cwd, parsed);

  if (command === "plan") {
    const task = parsed.takeTask("Usage: codex-mimo plan <task>");
    parsed.assertConsumed();
    return (dependencies.mimoPlan ?? defaultMimoPlan)({ ...common, task });
  }
  if (command === "implement") {
    if (!parsed.takeBoolean("--allow-write")) {
      throw new CliInputError("codex-mimo implement requires --allow-write.");
    }
    const task = parsed.takeTask("Usage: codex-mimo implement --allow-write <task>");
    parsed.assertConsumed();
    return (dependencies.mimoImplement ?? defaultMimoImplement)({ ...common, task, allowWrite: true });
  }
  if (command === "review") {
    const base = parsed.takeValue("--base");
    parsed.assertConsumed();
    return (dependencies.mimoReview ?? defaultMimoReview)({ ...common, ...(base ? { base } : {}) });
  }
  if (command === "fix-ci") {
    const file = parsed.takeRequiredValue("--file");
    const task = parsed.takeOptionalTask();
    parsed.assertConsumed();
    return (dependencies.mimoFixCi ?? defaultMimoFixCi)({ ...common, file, ...(task ? { task } : {}) });
  }
  if (command === "resume") {
    const jobId = parsed.takeRequiredValue("--job-id");
    const task = parsed.takeTask("Usage: codex-mimo resume --job-id <job-id> <task>");
    parsed.assertConsumed();
    return (dependencies.mimoResume ?? defaultMimoResume)({ ...common, jobId, task });
  }

  const workflow = parsed.takeRequiredValue("--workflow");
  const file = parsed.takeValue("--file");
  const since = parsed.takeValue("--since");
  const verification = parsed.takeValues("--verify");
  const reportDir = parsed.takeValue("--report-dir");
  const task = parsed.takeOptionalTask();
  parsed.assertConsumed();
  const input = parseComposeInput({
    ...common,
    workflow,
    ...(task ? { task } : {}),
    ...(file ? { file } : {}),
    ...(since ? { since } : {}),
    ...(verification.length > 0 ? { verification } : {}),
    ...(reportDir ? { reportDir } : {})
  });
  return (dependencies.mimoCompose ?? defaultMimoCompose)(input);
}

async function runControl(
  command: string,
  cwd: string,
  parsed: ParsedArguments,
  dependencies: CliDependencies
): Promise<unknown> {
  if (command === "jobs") {
    const all = parsed.takeBoolean("--all");
    parsed.assertConsumed();
    return (dependencies.mimoJobs ?? defaultMimoJobs)({ cwd, all });
  }

  const jobId = parsed.takeValue("--job-id");
  if (command === "status") {
    parsed.assertConsumed();
    return (dependencies.mimoStatus ?? defaultMimoStatus)({ cwd, ...(jobId ? { jobId } : {}) });
  }
  if (command === "result") {
    parsed.assertConsumed();
    return (dependencies.mimoResult ?? defaultMimoResult)({ cwd, ...(jobId ? { jobId } : {}) });
  }
  if (command === "cancel") {
    if (!jobId) throw new CliInputError("codex-mimo cancel requires --job-id.");
    parsed.assertConsumed();
    return (dependencies.mimoCancel ?? defaultMimoCancel)({ cwd, jobId });
  }

  const sinceCursor = parsed.takeOptionalInteger("--since-cursor", false);
  const limit = parsed.takeOptionalInteger("--limit", true);
  const minLevel = parsed.takeValue("--min-level");
  const signalOptions = {
    cwd,
    ...(jobId ? { jobId } : {}),
    ...(sinceCursor === undefined ? {} : { sinceCursor }),
    ...(limit === undefined ? {} : { limit }),
    ...(minLevel === undefined ? {} : { minLevel })
  };
  if (command === "events") {
    parsed.assertConsumed();
    return (dependencies.mimoEvents ?? defaultMimoEvents)(signalOptions);
  }

  const timeoutMs = parsed.takeOptionalInteger("--timeout-ms", true);
  parsed.assertConsumed();
  return (dependencies.mimoWait ?? defaultMimoWait)({
    ...signalOptions,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
}

async function runInternal(
  command: string,
  cwd: string,
  parsed: ParsedArguments,
  dependencies: CliDependencies
): Promise<void> {
  if (command === "job-supervisor") {
    parsed.assertConsumed();
    await (dependencies.runJobSupervisor ?? defaultRunJobSupervisor)(cwd);
    return;
  }
  if (command === "job-worker") {
    const jobId = parsed.takeRequiredValue("--job-id");
    parsed.assertConsumed();
    await (dependencies.runJobWorker ?? defaultRunJobWorker)(cwd, jobId);
    return;
  }
  parsed.assertConsumed();
  await (dependencies.runNotificationWorker ?? defaultRunNotificationWorker)(cwd);
}

function parseJobOptions(cwd: string, parsed: ParsedArguments) {
  const model = parsed.takeValue("--model");
  const timeoutMs = parsed.takeOptionalInteger("--timeout-ms", true);
  const idleTimeoutMs = parsed.takeOptionalInteger("--idle-timeout-ms", false);
  const notify = parseNotification(parsed);
  return {
    cwd,
    ...(model ? { model } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    ...(notify ? { notify } : {})
  };
}

function parseNotification(parsed: ParsedArguments): NotificationInput | undefined {
  const kind = parsed.takeValue("--notify");
  const threadId = parsed.takeValue("--thread-id");
  const url = parsed.takeValue("--url");
  const secretEnv = parsed.takeValue("--secret-env");

  if (!kind) {
    if (threadId || url || secretEnv) throw new CliInputError("Notification details require --notify.");
    return undefined;
  }
  if (kind === "codex") {
    if (url || secretEnv) throw new CliInputError("Codex notifications do not accept --url or --secret-env.");
    return { type: "codex", ...(threadId ? { threadId } : {}) };
  }
  if (kind === "webhook") {
    if (threadId) throw new CliInputError("Webhook notifications do not accept --thread-id.");
    if (!url || !secretEnv) {
      throw new CliInputError("Webhook notifications require --url and --secret-env.");
    }
    return { type: "webhook", url, secretEnv };
  }
  throw new CliInputError("--notify must be codex or webhook.");
}

class ParsedArguments {
  readonly #positionals: string[];
  readonly #flags: Map<string, string[]>;

  constructor(positionals: string[], flags: Map<string, string[]>) {
    this.#positionals = positionals;
    this.#flags = flags;
  }

  takeValue(flag: string): string | undefined {
    const values = this.#flags.get(flag);
    if (!values) return undefined;
    this.#flags.delete(flag);
    if (values.length !== 1) throw new CliInputError(`${flag} may only be specified once.`);
    return values[0];
  }

  takeRequiredValue(flag: string): string {
    const value = this.takeValue(flag);
    if (!value) throw new CliInputError(`codex-mimo requires ${flag}.`);
    return value;
  }

  takeValues(flag: string): string[] {
    const values = this.#flags.get(flag) ?? [];
    this.#flags.delete(flag);
    return values;
  }

  takeBoolean(flag: string): boolean {
    const values = this.#flags.get(flag);
    if (!values) return false;
    this.#flags.delete(flag);
    if (values.length !== 1) throw new CliInputError(`${flag} may only be specified once.`);
    return true;
  }

  takeOptionalInteger(flag: string, positive: boolean): number | undefined {
    const raw = this.takeValue(flag);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    const valid = Number.isInteger(value) && (positive ? value > 0 : value >= 0);
    if (!valid) {
      throw new CliInputError(`${flag} must be a ${positive ? "positive" : "non-negative"} integer.`);
    }
    return value;
  }

  takeTask(usage: string): string {
    const task = this.takeOptionalTask();
    if (!task) throw new CliInputError(usage);
    return task;
  }

  takeOptionalTask(): string | undefined {
    const task = this.#positionals.join(" ").trim();
    this.#positionals.length = 0;
    return task || undefined;
  }

  assertConsumed(): void {
    if (this.#flags.size > 0) {
      throw new CliInputError(`Unsupported option: ${this.#flags.keys().next().value as string}`);
    }
    if (this.#positionals.length > 0) {
      throw new CliInputError(`Unexpected argument: ${this.#positionals[0]}`);
    }
  }
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (REMOVED_FLAGS.has(token)) throw new CliInputError(`Unsupported option: ${token}`);
    if (BOOLEAN_FLAGS.has(token)) {
      appendFlag(flags, token, "true");
      continue;
    }
    if (!VALUE_FLAGS.has(token)) throw new CliInputError(`Unsupported option: ${token}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliInputError(`${token} requires a value.`);
    }
    appendFlag(flags, token, value);
    index += 1;
  }
  return new ParsedArguments(positionals, flags);
}

function appendFlag(flags: Map<string, string[]>, flag: string, value: string): void {
  flags.set(flag, [...(flags.get(flag) ?? []), value]);
}

class CliInputError extends InputValidationError {}

function isFailedHealthcheck(result: unknown): boolean {
  return typeof result === "object" && result !== null && "ok" in result && result.ok === false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
