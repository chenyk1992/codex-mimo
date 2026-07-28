/**
 * Frozen safety contracts for session isolation, write-scope, and multi-cause failures.
 * Wave-A/B/D/E implementations must consume these names verbatim — do not invent aliases.
 */

/** Stable job / guard error codes introduced by the isolation & safety work. */
export const SAFETY_ERROR_CODES = [
  "prompt_identity_mismatch",
  "callback_session_mismatch",
  "event_session_mismatch",
  "write_scope_violation",
  "acceptance_command_unavailable"
] as const;

export type SafetyErrorCode = (typeof SAFETY_ERROR_CODES)[number];

/**
 * Outcome classification priority (highest first). Guard failures must not be
 * overwritten by ordinary callback_cancelled.
 */
export const SAFETY_OUTCOME_PRIORITY = [
  "user_cancelled",
  "prompt_identity_mismatch",
  "event_session_mismatch",
  "callback_session_mismatch",
  "progress_timeout",
  "idle_timeout",
  "process_timeout",
  "callback_missing",
  "callback_error",
  "callback_cancelled",
  "verification",
  "mimo_exit_nonzero",
  "completed"
] as const;

export type JobFailureCauseStage =
  | "prompt"
  | "execution"
  | "callback"
  | "scope_check"
  | "build"
  | "test"
  | "diff_check";

export interface JobFailureCause {
  code: string;
  stage: JobFailureCauseStage;
  command?: string;
  suggestion?: string;
}

/** Compact failure surfaces keep at most this many causes; standard/full keep the full list. */
export const COMPACT_FAILURE_CAUSE_LIMIT = 3;

export interface HookExecutionGuardInput {
  expectedQueryHash: string;
  allowedPaths?: string[];
}

export type HookGuardFailure =
  | { code: "prompt_identity_mismatch"; sessionId: string }
  | { code: "write_scope_violation"; sessionId: string; path: string };

/**
 * Frozen allowedPaths pattern syntax (repository-relative, `/` separators):
 * - `src/app.ts` — exact file
 * - `src/components` — directory and descendants
 * - `src/components/**` — directory and descendants (trailing `/**` only)
 *
 * Rejected: bare `**`, `.`, empty, absolute, `..`, UNC, `*`, `?`, `[]`, mid-path globs.
 */
export const PATH_SCOPE_SYNTAX = {
  allowExactFile: true,
  allowDirectoryPrefix: true,
  allowTrailingDoubleStar: true,
  rejectBareDoubleStar: true,
  rejectDotOrEmpty: true,
  rejectAbsolute: true,
  rejectDotDot: true,
  rejectUnc: true,
  rejectUnsupportedGlob: true,
  caseSensitive: true
} as const;

export const SINGLE_MODE_ALLOWED_PATHS_REQUIRED_MESSAGE =
  'batchMode "single" requires bounded allowedPaths; repository-wide "**" is not allowed.';

export const MAX_ALLOWED_PATHS_JSON_ENV_CHARS = 16_384;
export const MAX_STAGED_CALLBACKS = 8;

/**
 * Bridge-owned execution policy for tasks that must not mutate the workspace.
 * It intentionally omits model/provider settings so MiMoCode resolves those
 * exclusively from its own configuration.
 */
export const CODEX_MIMO_READONLY_AGENT = "codex-mimo-readonly" as const;

export const WRITE_TOOL_NAMES = ["write", "edit"] as const;
export const WRITE_PATH_FIELD_PRIORITY = ["file_path", "filepath", "filePath", "path"] as const;

export type VerificationFailureKind = "command_not_found" | "exit_nonzero" | "aborted";
export type CommandResolutionKind = "unchanged" | "maven_wrapper" | "gradle_wrapper";
export type CommandResolutionSource = "explicit" | "detected";

export const SCOPE_CHECK_GATE = "scope_check" as const;
/** First-version public mapping for scope_check failures. */
export const SCOPE_CHECK_PUBLIC_MAPPING = {
  errorCode: "write_scope_violation",
  failedStage: "diff_check"
} as const;
