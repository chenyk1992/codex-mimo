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
