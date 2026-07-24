import { describe, expect, it } from "vitest";
import { resolveNotificationTarget } from "../../../src/notify/target.js";

describe("resolveNotificationTarget", () => {
  it("resolves explicit targets", () => {
    expect(resolveNotificationTarget({ type: "codex", threadId: "explicit" }))
      .toEqual({ type: "codex", threadId: "explicit" });
    expect(resolveNotificationTarget({ type: "webhook", url: "https://example.test/hook", secretEnv: "HOOK_SECRET" }))
      .toEqual({ type: "webhook", url: "https://example.test/hook", secretEnv: "HOOK_SECRET" });
  });

  it("returns undefined when notify is omitted", () => {
    expect(resolveNotificationTarget(undefined)).toBeUndefined();
  });

  it("rejects explicit Codex target without threadId", () => {
    expect(() => resolveNotificationTarget({ type: "codex" } as never))
      .toThrow("Codex notification requires explicit threadId");
  });

  it.each(["file:///tmp/hook", "ftp://example.test/hook", "not-a-url"])("rejects webhook URL %s", (url) => {
    expect(() => resolveNotificationTarget({ type: "webhook", url, secretEnv: "HOOK_SECRET" }))
      .toThrow("Webhook URL must use http or https");
  });

  it("rejects blank explicit Codex threadId", () => {
    expect(() => resolveNotificationTarget({ type: "codex", threadId: " " }))
      .toThrow("Codex notification requires explicit threadId");
  });

  it("trims target fields and rejects empty webhook secrets", () => {
    expect(resolveNotificationTarget({ type: "codex", threadId: " thread-1 " }))
      .toEqual({ type: "codex", threadId: "thread-1" });
    expect(resolveNotificationTarget({ type: "webhook", url: " https://example.test/hook ", secretEnv: " HOOK_SECRET " }))
      .toEqual({ type: "webhook", url: "https://example.test/hook", secretEnv: "HOOK_SECRET" });
    expect(() => resolveNotificationTarget({ type: "webhook", url: "https://example.test/hook", secretEnv: " " }))
      .toThrow("Webhook notification requires secretEnv");
  });
});
