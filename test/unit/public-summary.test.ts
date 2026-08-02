import { describe, expect, it } from "vitest";
import { publicProgressSummary } from "../../src/core/public-summary.js";

describe("publicProgressSummary", () => {
  it("emits a fixed safe summary for known operator errorCode stale_queued", () => {
    expect(
      publicProgressSummary({
        type: "job",
        status: "failed",
        errorCode: "stale_queued"
      })
    ).toBe("MiMoCode job stayed queued too long.");
  });

  it("emits a fixed safe summary for known operator errorCode idle_timeout", () => {
    expect(
      publicProgressSummary({
        type: "job",
        status: "timeout",
        errorCode: "idle_timeout"
      })
    ).toBe("MiMoCode job idle-timed out.");
  });

  it("explains missing acceptance configuration for needs_input jobs and signals", () => {
    const expected = "MiMoCode needs explicit acceptance commands before it can continue.";
    expect(
      publicProgressSummary({
        type: "job",
        status: "needs_input",
        errorCode: "acceptance_config_missing"
      })
    ).toBe(expected);
    expect(
      publicProgressSummary({
        type: "signal",
        kind: "needs_input",
        errorCode: "acceptance_config_missing"
      })
    ).toBe(expected);
  });

  it("falls back to the generic failed summary for unknown errorCodes", () => {
    expect(
      publicProgressSummary({
        type: "job",
        status: "failed",
        errorCode: "agent_said_something_secret"
      })
    ).toBe("MiMoCode job failed.");
  });

  it("uses a safe explanation when frozen review input was modified", () => {
    expect(publicProgressSummary({
      type: "job",
      status: "failed",
      errorCode: "review_attachment_modified"
    })).toContain("review input changed");
  });

  it("does not pass through arbitrary strings via unknown errorCode values", () => {
    const raw = "SECRET_PATH_C:/users/admin/.env leaked command";
    const summary = publicProgressSummary({
      type: "job",
      status: "failed",
      errorCode: raw
    });
    expect(summary).toBe("MiMoCode job failed.");
    expect(summary).not.toContain(raw);
    expect(summary).not.toContain("SECRET");
  });
});
