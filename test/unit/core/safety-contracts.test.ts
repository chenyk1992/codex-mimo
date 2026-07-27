import { describe, expect, it } from "vitest";
import {
  COMPACT_FAILURE_CAUSE_LIMIT,
  PATH_SCOPE_SYNTAX,
  SAFETY_ERROR_CODES,
  SAFETY_OUTCOME_PRIORITY,
  SINGLE_MODE_ALLOWED_PATHS_REQUIRED_MESSAGE,
  SCOPE_CHECK_PUBLIC_MAPPING
} from "../../../src/core/safety-contracts.js";

describe("frozen safety contracts", () => {
  it("locks the new safety error codes", () => {
    expect([...SAFETY_ERROR_CODES]).toEqual([
      "prompt_identity_mismatch",
      "callback_session_mismatch",
      "event_session_mismatch",
      "write_scope_violation",
      "acceptance_command_unavailable"
    ]);
  });

  it("locks outcome priority with prompt guard above callback_cancelled", () => {
    expect(SAFETY_OUTCOME_PRIORITY.indexOf("prompt_identity_mismatch")).toBeLessThan(
      SAFETY_OUTCOME_PRIORITY.indexOf("callback_cancelled")
    );
    expect(SAFETY_OUTCOME_PRIORITY[0]).toBe("user_cancelled");
  });

  it("locks path pattern syntax and single-mode message", () => {
    expect(PATH_SCOPE_SYNTAX.rejectBareDoubleStar).toBe(true);
    expect(PATH_SCOPE_SYNTAX.allowTrailingDoubleStar).toBe(true);
    expect(PATH_SCOPE_SYNTAX.caseSensitive).toBe(true);
    expect(SINGLE_MODE_ALLOWED_PATHS_REQUIRED_MESSAGE).toContain('batchMode "single"');
    expect(SINGLE_MODE_ALLOWED_PATHS_REQUIRED_MESSAGE).toContain('"**"');
  });

  it("locks compact cause limit and scope_check public mapping", () => {
    expect(COMPACT_FAILURE_CAUSE_LIMIT).toBe(3);
    expect(SCOPE_CHECK_PUBLIC_MAPPING).toEqual({
      errorCode: "write_scope_violation",
      failedStage: "diff_check"
    });
  });
});
