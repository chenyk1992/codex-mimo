import { describe, expect, it } from "vitest";
import { resolveNotificationTarget } from "../../../src/notify/target.js";

describe("resolveNotificationTarget", () => {
  it("freezes explicit targets before CODEX_THREAD_ID", () => {
    expect(resolveNotificationTarget({ type: "codex", threadId: "explicit" }, { CODEX_THREAD_ID: "ambient" }))
      .toEqual({ type: "codex", threadId: "explicit" });
    expect(resolveNotificationTarget({ type: "webhook", url: "https://example.test/hook", secretEnv: "HOOK_SECRET" }, {}))
      .toEqual({ type: "webhook", url: "https://example.test/hook", secretEnv: "HOOK_SECRET" });
  });

  it("uses ambient Codex thread only when notify is omitted", () => {
    expect(resolveNotificationTarget(undefined, { CODEX_THREAD_ID: "thread-1" }))
      .toEqual({ type: "codex", threadId: "thread-1" });
    expect(resolveNotificationTarget(undefined, {})).toBeUndefined();
  });

  it.each(["file:///tmp/hook", "ftp://example.test/hook", "not-a-url"])("rejects webhook URL %s", (url) => {
    expect(() => resolveNotificationTarget({ type: "webhook", url, secretEnv: "HOOK_SECRET" }, {}))
      .toThrow("Webhook URL must use http or https");
  });

  it("rejects unresolved explicit Codex target", () => {
    expect(() => resolveNotificationTarget({ type: "codex" }, {})).toThrow("Codex notification requires threadId");
  });

  it("trims target fields and rejects empty webhook secrets", () => {
    expect(resolveNotificationTarget({ type: "codex", threadId: " thread-1 " }, {}))
      .toEqual({ type: "codex", threadId: "thread-1" });
    expect(resolveNotificationTarget({ type: "webhook", url: " https://example.test/hook ", secretEnv: " HOOK_SECRET " }, {}))
      .toEqual({ type: "webhook", url: "https://example.test/hook", secretEnv: "HOOK_SECRET" });
    expect(() => resolveNotificationTarget({ type: "webhook", url: "https://example.test/hook", secretEnv: " " }, {}))
      .toThrow("Webhook notification requires secretEnv");
  });
});
