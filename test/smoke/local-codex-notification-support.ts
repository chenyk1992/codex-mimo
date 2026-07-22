import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { resolveMimoCommand } from "../../src/mimo/run-json.js";

export const INSTALLED_PLUGIN_ROOT_ENV = "CODEX_MIMO_INSTALLED_PLUGIN_ROOT";

export function resolveInstalledPluginRoot(
  checkoutRoot: string,
  env: NodeJS.ProcessEnv
): string {
  const configured = env[INSTALLED_PLUGIN_ROOT_ENV]?.trim();
  if (!configured) {
    throw new Error(
      `${INSTALLED_PLUGIN_ROOT_ENV} must point to the installed codex-mimocode plugin package.`
    );
  }

  const checkout = realPluginRoot(checkoutRoot, "Source checkout");
  const installed = realPluginRoot(configured, "Installed codex-mimocode plugin");
  if (samePath(checkout.root, installed.root)) {
    throw new Error(`${INSTALLED_PLUGIN_ROOT_ENV} must not point to the source checkout.`);
  }
  if (installed.version !== checkout.version) {
    throw new Error(
      `Installed codex-mimocode plugin version ${installed.version} does not match ` +
      `checkout version ${checkout.version}.`
    );
  }
  return installed.root;
}

export function withoutCodexPathCandidates(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pathValue = env.PATH ?? env.Path ?? "";
  const commandNames = ["codex", ...extensions(env).map((extension) => `codex${extension}`)];
  const isolatedPath = pathValue.split(path.delimiter)
    .filter((directory) => directory.length > 0)
    .filter((directory) => !commandNames.some((name) => existsSync(path.resolve(directory, name))))
    .join(path.delimiter);
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) =>
      name.toLowerCase() !== "path" && name.toLowerCase() !== "codex_mimo_codex_bin"
    )),
    PATH: isolatedPath
  };
}

export function prepareCodexNotificationSmokeEnvironment(
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const mimoCommand = resolveAbsoluteMimoCommand(env);
  const isolated = withoutCodexPathCandidates(env);
  return {
    ...Object.fromEntries(Object.entries(isolated).filter(([name]) => {
      const normalized = name.toLowerCase();
      return normalized !== "codex_mimo_command" && normalized !== "mimo_command";
    })),
    CODEX_MIMO_COMMAND: mimoCommand
  };
}

function resolveAbsoluteMimoCommand(env: NodeJS.ProcessEnv): string {
  const command = resolveMimoCommand(env);
  if (path.isAbsolute(command)) return path.normalize(command);
  if (command.includes("/") || command.includes("\\")) return path.resolve(command);

  const pathValue = env.PATH ?? env.Path ?? "";
  const commandNames = [command, ...extensions(env).map((extension) => `${command}${extension}`)];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const name of commandNames) {
      const candidate = path.resolve(directory, name);
      if (existsSync(candidate)) return realpathSync(candidate);
    }
  }
  throw new Error(`Unable to resolve MiMoCode command to an absolute path: ${command}`);
}

function realPluginRoot(root: string, label: string): { root: string; version: string } {
  if (!path.isAbsolute(root)) throw new Error(`${label} root must be an absolute path.`);
  let resolved: string;
  try {
    resolved = realpathSync(root);
  } catch {
    throw new Error(`${label} root does not exist: ${root}`);
  }
  const manifestFile = path.join(resolved, ".codex-plugin", "plugin.json");
  const mcpFile = path.join(resolved, ".mcp.json");
  if (!existsSync(mcpFile)) throw new Error(`${label} is missing .mcp.json: ${resolved}`);

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as unknown;
  } catch {
    throw new Error(`${label} has no readable plugin manifest: ${resolved}`);
  }
  if (!isPluginManifest(manifest)) {
    throw new Error(`${label} has an invalid codex-mimocode plugin manifest: ${resolved}`);
  }
  return { root: resolved, version: manifest.version };
}

function isPluginManifest(value: unknown): value is { name: "codex-mimocode"; version: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  return manifest.name === "codex-mimocode" &&
    typeof manifest.version === "string" && manifest.version.trim() !== "";
}

function extensions(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter((extension) => extension.length > 0)
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
