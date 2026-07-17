export const UTF8_PROCESS_ENV = {
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8"
} as const;

export interface ProcessEnvOptions {
  base?: NodeJS.ProcessEnv;
  omit?: readonly string[];
  platform?: NodeJS.Platform;
}

export interface OmitEnvironmentVariablesOptions {
  caseInsensitive?: boolean;
}

export function omitEnvironmentVariables(
  source: NodeJS.ProcessEnv,
  omittedNames: readonly string[] = [],
  options: OmitEnvironmentVariablesOptions = {}
): NodeJS.ProcessEnv {
  const omitted = new Set(
    options.caseInsensitive
      ? omittedNames.map((name) => name.toLowerCase())
      : omittedNames
  );
  const filtered: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(source)) {
    const comparedKey = options.caseInsensitive ? key.toLowerCase() : key;
    if (!omitted.has(comparedKey)) filtered[key] = value;
  }

  return filtered;
}

export function withUtf8ProcessEnv(
  env: NodeJS.ProcessEnv = {},
  options: ProcessEnvOptions = {}
): NodeJS.ProcessEnv {
  const merged = { ...(options.base ?? process.env), ...env };

  if (!merged.PYTHONUTF8) merged.PYTHONUTF8 = UTF8_PROCESS_ENV.PYTHONUTF8;
  if (!merged.PYTHONIOENCODING) merged.PYTHONIOENCODING = UTF8_PROCESS_ENV.PYTHONIOENCODING;
  return omitEnvironmentVariables(merged, options.omit, {
    caseInsensitive: (options.platform ?? process.platform) === "win32"
  });
}
