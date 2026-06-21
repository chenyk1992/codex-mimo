import { describe, expect, it } from "vitest";
import {
  decideCommand,
  decideFileRead,
  decideFileWrite,
  defaultPolicy
} from "../../src/core/policy.js";

describe("policy", () => {
  const policy = defaultPolicy("E:/project/app");

  it("allows normal reads inside the workspace", () => {
    expect(decideFileRead(policy, "E:/project/app/src/index.ts")).toBe("allow");
  });

  it("denies secret reads", () => {
    expect(decideFileRead(policy, "E:/project/app/.env")).toBe("deny");
  });

  it("denies writes outside the workspace", () => {
    expect(decideFileWrite(policy, "E:/other/app/src/index.ts")).toBe("deny");
  });

  it("asks before normal writes", () => {
    expect(decideFileWrite(policy, "E:/project/app/src/index.ts")).toBe("ask");
  });

  it("allows safe verification commands", () => {
    expect(decideCommand(policy, "npm test -- session.test.ts")).toBe("allow");
  });

  it("denies dangerous git commands", () => {
    expect(decideCommand(policy, "git push origin main")).toBe("deny");
  });
});
