export const UTF8_PROCESS_ENV = {
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8"
} as const;

export function withUtf8ProcessEnv(
  env: NodeJS.ProcessEnv = {},
  base: NodeJS.ProcessEnv = process.env,
  omit: readonly string[] = []
): NodeJS.ProcessEnv {
  const merged = { ...base, ...env };

  if (!merged.PYTHONUTF8) merged.PYTHONUTF8 = UTF8_PROCESS_ENV.PYTHONUTF8;
  if (!merged.PYTHONIOENCODING) merged.PYTHONIOENCODING = UTF8_PROCESS_ENV.PYTHONIOENCODING;
  for (const key of omit) delete merged[key];

  return merged;
}
