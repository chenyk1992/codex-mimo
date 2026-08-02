import fs from "node:fs";
import path from "node:path";

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

/**
 * The compatibility policy keeps the credentials commonly used by MiMoCode,
 * while removing credentials that belong to the host, notifications, or other
 * unrelated cloud tooling. Strict mode requires a known selected provider and
 * passes only that provider's explicitly allowed variables.
 */
export type MimoExecutionEnvironmentPolicy = "compat" | "strict";

export interface BuildMimoExecutionEnvOptions {
  platform?: NodeJS.Platform;
  policy?: MimoExecutionEnvironmentPolicy;
  /** An explicit MiMo provider takes precedence over configuration discovery. */
  provider?: string;
  /** Extra non-secret names needed by an embedding or an integration test. */
  allowEnv?: readonly string[];
  /** Names that must be present in strict mode, in addition to provider defaults. */
  requiredCredentialNames?: readonly string[];
  /** Names that must never reach MiMo even if an embedding supplied them. */
  omit?: readonly string[];
}

export interface MimoExecutionEnvironmentAudit {
  policy: MimoExecutionEnvironmentPolicy;
  provider?: string;
  /** Names only: this deliberately never contains environment values. */
  passedNames: string[];
  omittedCount: number;
}

export interface MimoExecutionEnvironment {
  env: NodeJS.ProcessEnv;
  audit: MimoExecutionEnvironmentAudit;
}

export class MimoExecutionEnvironmentError extends Error {
  readonly code: "strict_provider_required" | "strict_credentials_missing";
  readonly variableNames: string[];

  constructor(
    code: MimoExecutionEnvironmentError["code"],
    message: string,
    variableNames: readonly string[] = []
  ) {
    super(message);
    this.name = "MimoExecutionEnvironmentError";
    this.code = code;
    this.variableNames = [...variableNames];
  }
}

const WINDOWS_SYSTEM_ENV = [
  "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH", "TEMP", "TMP",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA"
] as const;
const POSIX_SYSTEM_ENV = [
  "HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
  "TERM", "SHELL", "USER", "LOGNAME", "XDG_CONFIG_HOME"
] as const;
const BRIDGE_ENV = [
  "MIMOCODE_CONFIG_DIR", "MIMOCODE_CONFIG_CONTENT", "MIMOCODE_PROVIDER",
  "CODEX_MIMO_INVOCATION_ID", "CODEX_MIMO_CALLBACK_ENDPOINT",
  "CODEX_MIMO_CALLBACK_TOKEN", "CODEX_MIMO_EXPECTED_QUERY_HASH",
  "CODEX_MIMO_ALLOWED_PATHS_JSON"
] as const;
const COMMAND_ENV = ["CODEX_MIMO_COMMAND", "MIMO_COMMAND"] as const;
const PROXY_AND_TLS_ENV = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"
] as const;
const GIT_ENV = [
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM",
  "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "GIT_SSH_COMMAND"
] as const;
const NPM_ENV = [
  "NPM_CONFIG_REGISTRY", "NPM_CONFIG_PROXY", "NPM_CONFIG_HTTPS_PROXY",
  "NPM_CONFIG_CAFILE", "NPM_CONFIG_STRICT_SSL", "NPM_CONFIG_CACHE",
  "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG", "NPM_CONFIG_PREFIX",
  "NPM_CONFIG_FETCH_RETRIES", "NPM_CONFIG_FETCH_RETRY_FACTOR",
  "NPM_CONFIG_FETCH_RETRY_MINTIMEOUT", "NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT"
] as const;

interface ProviderProfile {
  aliases: readonly string[];
  env: readonly string[];
  required: readonly string[];
  requiredAny?: readonly string[];
  /** Cloud credentials are withheld in compat unless this provider is selected. */
  cloud?: boolean;
}

const PROVIDER_PROFILES: Record<string, ProviderProfile> = {
  openai: { aliases: ["openai"], env: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT"], required: ["OPENAI_API_KEY"] },
  anthropic: { aliases: ["anthropic"], env: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"], required: ["ANTHROPIC_API_KEY"] },
  google: { aliases: ["google", "gemini", "google-generative-ai"], env: ["GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"], required: [], requiredAny: ["GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] },
  azure: { aliases: ["azure", "azure-openai"], env: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_VERSION"], required: ["AZURE_OPENAI_API_KEY"], cloud: true },
  openrouter: { aliases: ["openrouter"], env: ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"], required: ["OPENROUTER_API_KEY"] },
  groq: { aliases: ["groq"], env: ["GROQ_API_KEY"], required: ["GROQ_API_KEY"] },
  deepseek: { aliases: ["deepseek"], env: ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"], required: ["DEEPSEEK_API_KEY"] },
  mistral: { aliases: ["mistral"], env: ["MISTRAL_API_KEY"], required: ["MISTRAL_API_KEY"] },
  cohere: { aliases: ["cohere"], env: ["COHERE_API_KEY"], required: ["COHERE_API_KEY"] },
  xai: { aliases: ["xai", "grok"], env: ["XAI_API_KEY"], required: ["XAI_API_KEY"] },
  moonshot: { aliases: ["moonshot", "kimi"], env: ["MOONSHOT_API_KEY", "KIMI_API_KEY"], required: [], requiredAny: ["MOONSHOT_API_KEY", "KIMI_API_KEY"] },
  qwen: { aliases: ["qwen", "dashscope"], env: ["DASHSCOPE_API_KEY"], required: ["DASHSCOPE_API_KEY"] },
  zhipu: { aliases: ["zhipu", "zai"], env: ["ZHIPUAI_API_KEY"], required: ["ZHIPUAI_API_KEY"] },
  minimax: { aliases: ["minimax"], env: ["MINIMAX_API_KEY"], required: ["MINIMAX_API_KEY"] },
  volcengine: { aliases: ["volcengine", "ark"], env: ["VOLCENGINE_API_KEY", "ARK_API_KEY"], required: [], requiredAny: ["VOLCENGINE_API_KEY", "ARK_API_KEY"] },
  together: { aliases: ["together"], env: ["TOGETHER_API_KEY"], required: ["TOGETHER_API_KEY"] },
  fireworks: { aliases: ["fireworks"], env: ["FIREWORKS_API_KEY"], required: ["FIREWORKS_API_KEY"] },
  perplexity: { aliases: ["perplexity"], env: ["PERPLEXITY_API_KEY"], required: ["PERPLEXITY_API_KEY"] },
  cerebras: { aliases: ["cerebras"], env: ["CEREBRAS_API_KEY"], required: ["CEREBRAS_API_KEY"] },
  bedrock: { aliases: ["bedrock", "aws-bedrock"], env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION"], required: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"], cloud: true },
  ollama: { aliases: ["ollama", "local", "lmstudio", "lm-studio"], env: ["OLLAMA_HOST"], required: [] }
};

const NON_PROVIDER_MIMO_ENV = ["MIMOCODE_API_KEY"] as const;

/**
 * Builds the environment supplied to the MiMo child process. It intentionally
 * does not inherit arbitrary host variables. `compat` is intentionally
 * conservative: where the current MiMo configuration does not unambiguously
 * identify one provider, it retains known non-cloud provider credentials so a
 * local existing provider setup keeps working. It is not a credential-exfiltration
 * boundary; use strict mode plus an explicit provider for that posture.
 */
export function buildMimoExecutionEnv(
  base: NodeJS.ProcessEnv = process.env,
  additions: NodeJS.ProcessEnv = {},
  options: BuildMimoExecutionEnvOptions = {}
): MimoExecutionEnvironment {
  const platform = options.platform ?? process.platform;
  const caseInsensitive = platform === "win32";
  const merged = mergeEnvironment(base, additions, caseInsensitive);
  const policy = resolveMimoEnvironmentPolicy(options.policy, merged, caseInsensitive);
  const provider = resolveMimoProvider(options.provider, merged, caseInsensitive);
  const profile = provider ? PROVIDER_PROFILES[provider] : undefined;

  if (policy === "strict" && !profile) {
    throw new MimoExecutionEnvironmentError(
      "strict_provider_required",
      "Strict MiMo environment policy requires a known explicitly selected provider (options.provider, MIMOCODE_PROVIDER, or a unique provider in MIMOCODE_CONFIG_CONTENT)."
    );
  }

  const trustedAllowed = new Set<string>();
  const allowTrusted = (names: readonly string[]) => names.forEach((name) =>
    trustedAllowed.add(normalizeEnvName(name, caseInsensitive))
  );
  const callerAllowed = new Set((options.allowEnv ?? []).map((name) =>
    normalizeEnvName(name, caseInsensitive)
  ));
  allowTrusted(platform === "win32" ? WINDOWS_SYSTEM_ENV : POSIX_SYSTEM_ENV);
  allowTrusted(BRIDGE_ENV);
  allowTrusted(PROXY_AND_TLS_ENV);
  allowTrusted(GIT_ENV);
  allowTrusted(NPM_ENV);
  if (!caseInsensitive) {
    // Proxy libraries and npm commonly use their lower-case POSIX spellings.
    // Keep the allowlist explicit instead of making provider credentials
    // case-insensitive on platforms where environment names are distinct.
    allowTrusted(PROXY_AND_TLS_ENV.map((name) => name.toLowerCase()));
    allowTrusted(NPM_ENV.map((name) => name.toLowerCase()));
  }
  if (policy === "strict") {
    allowTrusted(profile!.env);
    allowTrusted(NON_PROVIDER_MIMO_ENV);
  } else if (profile) {
    allowTrusted(profile.env);
    allowTrusted(NON_PROVIDER_MIMO_ENV);
  } else {
    for (const candidate of Object.values(PROVIDER_PROFILES)) {
      if (!candidate.cloud) allowTrusted(candidate.env);
    }
    allowTrusted(NON_PROVIDER_MIMO_ENV);
  }

  const omitted = new Set<string>([
    ...COMMAND_ENV,
    ...(options.omit ?? [])
  ].map((name) => normalizeEnvName(name, caseInsensitive)));
  const env: NodeJS.ProcessEnv = {};
  let omittedCount = 0;
  for (const [normalized, entry] of merged) {
    const trusted = trustedAllowed.has(normalized);
    const callerPermitted = callerAllowed.has(normalized);
    if (
      omitted.has(normalized) ||
      isNonBypassableMimoEnvironmentName(normalized, trusted, caseInsensitive) ||
      (!trusted && !callerPermitted)
    ) {
      omittedCount += 1;
      continue;
    }
    env[entry.name] = entry.value;
  }

  const required = policy === "strict"
    ? [...(profile?.required ?? []), ...(options.requiredCredentialNames ?? [])]
    : [];
  const missing = required.filter((name) => !hasEnvironmentValue(env, name, caseInsensitive));
  const requiredAny = profile?.requiredAny ?? [];
  const hasRequiredAny = requiredAny.length === 0 || requiredAny.some((name) =>
    hasEnvironmentValue(env, name, caseInsensitive)
  );
  if (missing.length > 0 || !hasRequiredAny) {
    const missingNames = missing.length > 0 ? missing : [...requiredAny];
    throw new MimoExecutionEnvironmentError(
      "strict_credentials_missing",
      `Strict MiMo environment policy is missing required credential variable(s): ${missingNames.join(", ")}.`,
      missingNames
    );
  }

  const utf8 = withUtf8ProcessEnv(env, { base: {}, platform });
  return {
    env: utf8,
    audit: {
      policy,
      ...(provider ? { provider } : {}),
      passedNames: Object.keys(utf8).sort((left, right) => left.localeCompare(right)),
      omittedCount
    }
  };
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

interface EnvironmentEntry {
  name: string;
  value: string;
}

function mergeEnvironment(
  base: NodeJS.ProcessEnv,
  additions: NodeJS.ProcessEnv,
  caseInsensitive: boolean
): Map<string, EnvironmentEntry> {
  const merged = new Map<string, EnvironmentEntry>();
  const append = (source: NodeJS.ProcessEnv) => {
    for (const [name, rawValue] of Object.entries(source)) {
      if (rawValue === undefined) continue;
      const normalized = normalizeEnvName(name, caseInsensitive);
      // Replacing the prior casing is important on Windows: a child process
      // cannot meaningfully receive both PATH and Path.
      merged.set(normalized, { name, value: String(rawValue) });
    }
  };
  append(base);
  append(additions);
  return merged;
}

function normalizeEnvName(name: string, caseInsensitive: boolean): string {
  return caseInsensitive ? name.toUpperCase() : name;
}

function resolveMimoEnvironmentPolicy(
  requested: MimoExecutionEnvironmentPolicy | undefined,
  environment: Map<string, EnvironmentEntry>,
  caseInsensitive: boolean
): MimoExecutionEnvironmentPolicy {
  if (requested) return requested;
  const configured = readEnvironmentValue(environment, "CODEX_MIMO_ENV_POLICY", caseInsensitive)?.trim().toLowerCase();
  return configured === "strict" ? "strict" : "compat";
}

function resolveMimoProvider(
  requested: string | undefined,
  environment: Map<string, EnvironmentEntry>,
  caseInsensitive: boolean
): string | undefined {
  const explicit = canonicalProvider(requested);
  if (explicit) return explicit;
  const environmentProvider = canonicalProvider(
    readEnvironmentValue(environment, "MIMOCODE_PROVIDER", caseInsensitive)
  );
  if (environmentProvider) return environmentProvider;

  const content = readEnvironmentValue(environment, "MIMOCODE_CONFIG_CONTENT", caseInsensitive);
  const configuredProvider = resolveProviderFromConfigContent(content);
  if (configuredProvider) return configuredProvider;
  return resolveProviderFromConfigDirectory(
    readEnvironmentValue(environment, "MIMOCODE_CONFIG_DIR", caseInsensitive)
  );
}

function resolveProviderFromConfigContent(content: string | undefined): string | undefined {
  if (!content?.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(stripJsonCommentsAndTrailingCommas(content));
    const candidates = new Set<string>();
    collectConfiguredProviders(parsed, candidates);
    return candidates.size === 1 ? [...candidates][0] : undefined;
  } catch {
    // Runtime config validates this separately. Failing strict mode below is
    // safer than making a guess from malformed configuration.
    return undefined;
  }
}

function resolveProviderFromConfigDirectory(configDir: string | undefined): string | undefined {
  if (!configDir?.trim()) return undefined;
  try {
    const resolved = path.resolve(configDir);
    const stat = fs.statSync(resolved);
    const candidates = stat.isDirectory()
      ? ["mimocode.jsonc", "mimocode.json", "config.jsonc", "config.json"].map((name) => path.join(resolved, name))
      : [resolved];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
      const content = fs.readFileSync(candidate, "utf8");
      if (Buffer.byteLength(content, "utf8") > 1_048_576) continue;
      const provider = resolveProviderFromConfigContent(content);
      if (provider) return provider;
    }
  } catch {
    // Do not expose configuration paths or content in a process error.
  }
  return undefined;
}

function collectConfiguredProviders(value: unknown, providers: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectConfiguredProviders(entry, providers));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && /^(provider|providerId|provider_id)$/i.test(key)) {
      const provider = canonicalProvider(entry);
      if (provider) providers.add(provider);
    }
    // Several provider/model schemas use values such as "openai/gpt-4.1".
    if (typeof entry === "string" && /^(model|defaultModel|default_model)$/i.test(key)) {
      const provider = canonicalProvider(entry.split(/[/:]/, 1)[0]);
      if (provider) providers.add(provider);
    }
    collectConfiguredProviders(entry, providers);
  }
}

function canonicalProvider(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return Object.entries(PROVIDER_PROFILES).find(([, profile]) =>
    profile.aliases.includes(normalized)
  )?.[0];
}

function readEnvironmentValue(
  environment: Map<string, EnvironmentEntry>,
  name: string,
  caseInsensitive: boolean
): string | undefined {
  return environment.get(normalizeEnvName(name, caseInsensitive))?.value;
}

function hasEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  caseInsensitive: boolean
): boolean {
  const expected = normalizeEnvName(name, caseInsensitive);
  return Object.entries(environment).some(([key, value]) =>
    normalizeEnvName(key, caseInsensitive) === expected && Boolean(value?.trim())
  );
}

function isNonBypassableMimoEnvironmentName(
  normalized: string,
  trusted: boolean,
  caseInsensitive: boolean
): boolean {
  const comparable = caseInsensitive ? normalized : normalized.toUpperCase();
  if (comparable.includes("WEBHOOK")) return true;
  if (COMMAND_ENV.includes(comparable as typeof COMMAND_ENV[number])) return true;
  if (comparable.startsWith("CODEX_MIMO_") && !trusted) return true;
  // Trusted bridge callback and provider credentials are deliberate bridge
  // capabilities. `allowEnv` cannot make any new secret/token variable pass.
  if (trusted) return false;
  if (/^(AWS_|GCP_|GOOGLE_APPLICATION_CREDENTIALS$|AZURE_|GITHUB_|GH_TOKEN$|NPM_TOKEN$|VERCEL_TOKEN$|CLOUDFLARE_)/.test(comparable)) {
    return true;
  }
  return /(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ACCESS_KEY|API_KEY|CREDENTIAL)/.test(comparable);
}

function stripJsonCommentsAndTrailingCommas(source: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]!;
    const next = source[index + 1];
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      index += 1;
      while (index + 1 < source.length && source[index + 1] !== "\n" && source[index + 1] !== "\r") index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      index += 1;
      while (index + 1 < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      if (source[index + 1] === "/") index += 1;
      continue;
    }
    output += current;
  }
  return output.replace(/,(\s*[}\]])/g, "$1");
}
