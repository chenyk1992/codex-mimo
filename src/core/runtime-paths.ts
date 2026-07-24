export function normalizeWorkspacePath(file: string): string {
  return file.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Paths exempt from read-only violation checks: bridge runtime under
 * `.codex-mimo/` and MiMo project config/artifacts under `.mimocode/`.
 * Nested lookalikes such as `src/.mimocode/...` are not exempt.
 */
export function isRuntimeArtifactPath(file: string): boolean {
  const normalized = normalizeWorkspacePath(file);
  return normalized === ".codex-mimo" ||
    normalized.startsWith(".codex-mimo/") ||
    normalized === ".mimocode" ||
    normalized.startsWith(".mimocode/");
}
