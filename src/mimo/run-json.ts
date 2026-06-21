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
}

export function buildMimoRunArgs(options: MimoRunOptions): string[] {
  const args = ["run", "--format", "json"];
  if (options.agent) args.push("--agent", options.agent);
  if (options.model) args.push("--model", options.model);
  if (options.session) args.push("--session", options.session);
  if (options.fork) args.push("--fork");
  if (options.title) args.push("--title", options.title);
  if (options.attach) args.push("--attach", options.attach);
  for (const file of options.files ?? []) args.push("--file", file);
  args.push(options.message);
  return args;
}
