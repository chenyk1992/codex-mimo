/**
 * Repository-relative path scope matching for write guards and acceptance audits.
 * Pattern syntax is frozen in safety-contracts PATH_SCOPE_SYNTAX.
 */

export function normalizeRepositoryPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function validateAllowedPathPattern(pattern: string): string | null {
  const normalized = normalizeRepositoryPath(pattern.trim());
  if (!normalized || normalized === ".") {
    return "empty or dot path";
  }
  if (normalized === "**") {
    return "bare double-star";
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    return "absolute path";
  }
  if (normalized.includes("..")) {
    return "parent traversal";
  }
  if (normalized.startsWith("//") || normalized.startsWith("\\\\")) {
    return "UNC path";
  }
  if (normalized.includes("?") || normalized.includes("[") || normalized.includes("]")) {
    return "unsupported glob";
  }
  if (normalized.includes("*")) {
    if (!normalized.endsWith("/**")) {
      return "unsupported glob";
    }
    const prefix = normalized.slice(0, -3);
    if (!prefix || prefix.includes("*")) {
      return "unsupported glob";
    }
  }
  return null;
}

export function isPathWithinAllowedScope(filePath: string, allowedPaths: string[]): boolean {
  const normalized = normalizeRepositoryPath(filePath);
  return allowedPaths.some((pattern) => matchesAllowedPattern(normalized, pattern));
}

export function findOutOfScopePaths(paths: string[], allowedPaths: string[]): string[] {
  return paths.filter((filePath) => !isPathWithinAllowedScope(filePath, allowedPaths));
}

function matchesAllowedPattern(filePath: string, pattern: string): boolean {
  const normalizedPattern = normalizeRepositoryPath(pattern.trim());
  if (validateAllowedPathPattern(normalizedPattern) !== null) {
    return false;
  }
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  }
  return filePath === normalizedPattern || filePath.startsWith(`${normalizedPattern}/`);
}
