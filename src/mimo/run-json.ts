import { withUtf8ProcessEnv } from "../core/encoding.js";
import { listWebhookSecretEnvironmentNames } from "../core/job-store.js";

export interface MimoProcessSelection {
  command: string;
}

export function resolveMimoCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  return readEnvironmentValue(env, "CODEX_MIMO_COMMAND", platform) ||
    readEnvironmentValue(env, "MIMO_COMMAND", platform) ||
    "mimo";
}

export function resolveMimoProcessSelection(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): MimoProcessSelection {
  return {
    command: resolveMimoCommand(env, platform)
  };
}

export function buildMimoProbeEnvironment(cwd: string): NodeJS.ProcessEnv {
  return withUtf8ProcessEnv({}, { omit: listWebhookSecretEnvironmentNames(cwd) });
}

function readEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform
): string | undefined {
  const exact = env[name];
  if (exact || platform !== "win32") return exact;
  const matched = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return matched === undefined ? undefined : env[matched];
}

export interface MimoRunOptions {
  cwd: string;
  message: string;
  agent?: string;
  model?: string;
  session?: string;
  fork?: boolean;
  title?: string;
  attach?: string;
  files?: string[];
  continue?: boolean;
}

export function buildMimoRunArgs(options: MimoRunOptions): string[] {
  const args = ["run", "--format", "json"];
  if (options.agent) args.push("--agent", options.agent);
  if (options.model) args.push("--model", options.model);
  if (options.session) args.push("--session", options.session);
  if (options.fork) args.push("--fork");
  if (options.title) args.push("--title", options.title);
  if (options.attach) args.push("--attach", options.attach);
  if (options.continue) args.push("--continue");
  args.push(options.message);
  for (const file of options.files ?? []) args.push("--file", file);
  return args;
}
