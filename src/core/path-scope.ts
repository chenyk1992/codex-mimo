import {
  SCOPE_CHECK_GATE,
  SCOPE_CHECK_PUBLIC_MAPPING,
  type JobFailureCauseStage
} from "./safety-contracts.js";

export function normalizeRepositoryPath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/");
}

export function validateAllowedPathPattern(pattern: string): string | null {
  const normalized = normalizeRepositoryPath(pattern);

  if (!normalized || normalized === ".") {
    return "allowed path pattern must not be empty or '.'";
  }

  if (normalized === "**") {
    return 'repository-wide "**" is not allowed';
  }

  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return "allowed path pattern must be repository-relative";
  }

  if (normalized.startsWith("//") || normalized.startsWith("\\\\")) {
    return "allowed path pattern must not be a UNC path";
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    return "allowed path pattern must not contain '..' traversal";
  }

  if (normalized.includes("*") || normalized.includes("?") || /[[\]]/.test(normalized)) {
    if (normalized.endsWith("/**")) {
      const prefix = normalized.slice(0, -3);
      if (!prefix || prefix.includes("*") || prefix.includes("?") || /[[\]]/.test(prefix)) {
        return "unsupported glob in allowed path pattern";
      }
      return null;
    }
    return "unsupported glob in allowed path pattern";
  }

  return null;
}

function isExactFilePattern(pattern: string): boolean {
  const lastSegment = pattern.split("/").pop() ?? "";
  return lastSegment.includes(".");
}

function patternRoot(pattern: string): string {
  const normalized = normalizeRepositoryPath(pattern);
  if (normalized.endsWith("/**")) {
    return normalized.slice(0, -3).replace(/\/+$/, "");
  }
  return normalized.replace(/\/+$/, "");
}

export function allowedPathPatternsOverlap(first: string, second: string): boolean {
  const firstRoot = patternRoot(first);
  const secondRoot = patternRoot(second);
  return matchesAllowedPattern(firstRoot, second) || matchesAllowedPattern(secondRoot, first);
}

export function mergeAllowedPathScopes(
  ...scopes: Array<string[] | undefined>
): string[] | undefined {
  const merged = [...new Set(scopes.flatMap((scope) => scope ?? []))];
  return merged.length > 0 ? merged : undefined;
}

export function isPathWithinAllowedScope(filePath: string, allowedPaths: string[]): boolean {
  const normalizedFile = normalizeRepositoryPath(filePath);
  return allowedPaths.some((allowed) => matchesAllowedPattern(normalizedFile, allowed));
}

function matchesAllowedPattern(filePath: string, pattern: string): boolean {
  const normalizedPattern = normalizeRepositoryPath(pattern);
  const root = patternRoot(normalizedPattern);

  if (normalizedPattern.endsWith("/**") || normalizedPattern.endsWith("/")) {
    return filePath === root || filePath.startsWith(`${root}/`);
  }

  if (isExactFilePattern(normalizedPattern)) {
    return filePath === root;
  }

  return filePath === root || filePath.startsWith(`${root}/`);
}

export function findOutOfScopePaths(paths: string[], allowedPaths: string[]): string[] {
  if (allowedPaths.length === 0) {
    return [...paths];
  }
  return paths.filter((filePath) => !isPathWithinAllowedScope(filePath, allowedPaths));
}

export interface ScopeCheckInput {
  changedFiles: string[];
  allowedPaths: string[];
}

export interface ScopeCheckResult {
  gate: typeof SCOPE_CHECK_GATE;
  passed: boolean;
  outOfScopePaths: string[];
  publicErrorCode: typeof SCOPE_CHECK_PUBLIC_MAPPING.errorCode;
  publicFailedStage: typeof SCOPE_CHECK_PUBLIC_MAPPING.failedStage;
  failureStage: JobFailureCauseStage;
  reason?: string;
  suggestion?: string;
}

export function runScopeCheck(input: ScopeCheckInput): ScopeCheckResult {
  const outOfScopePaths = findOutOfScopePaths(input.changedFiles, input.allowedPaths);
  if (outOfScopePaths.length === 0) {
    return {
      gate: SCOPE_CHECK_GATE,
      passed: true,
      outOfScopePaths: [],
      publicErrorCode: SCOPE_CHECK_PUBLIC_MAPPING.errorCode,
      publicFailedStage: SCOPE_CHECK_PUBLIC_MAPPING.failedStage,
      failureStage: "scope_check"
    };
  }

  return {
    gate: SCOPE_CHECK_GATE,
    passed: false,
    outOfScopePaths,
    publicErrorCode: SCOPE_CHECK_PUBLIC_MAPPING.errorCode,
    publicFailedStage: SCOPE_CHECK_PUBLIC_MAPPING.failedStage,
    failureStage: "scope_check",
    reason: `Out-of-scope changes: ${outOfScopePaths.join(", ")}`,
    suggestion: `Remove out-of-scope change ${outOfScopePaths[0]}, then rerun the scope check.`
  };
}
