export function normalizeWorkspacePath(file: string): string {
  return file.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isRuntimeArtifactPath(file: string): boolean {
  const normalized = normalizeWorkspacePath(file);
  return normalized === ".codex-mimo" ||
    normalized.startsWith(".codex-mimo/") ||
    normalized === ".mimocode/.cron-lock";
}
