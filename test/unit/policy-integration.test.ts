import { describe, expect, it } from "vitest";
import {
  decideCommand,
  decideFileRead,
  decideFileWrite,
  defaultPolicy
} from "../../src/core/policy.js";
import { configToPolicy } from "../../src/core/config.js";

describe("policy integration", () => {
  describe("nonInteractive mode", () => {
    const policy = { ...defaultPolicy("E:/project/app"), nonInteractive: true };

    it("denies write (ask→deny)", () => {
      expect(decideFileWrite(policy, "E:/project/app/src/index.ts")).toBe("deny");
    });

    it("denies install commands (ask→deny)", () => {
      expect(decideCommand(policy, "npm install express")).toBe("deny");
    });

    it("denies build commands (ask→deny)", () => {
      expect(decideCommand(policy, "npm run build")).toBe("deny");
    });

    it("still allows safe commands", () => {
      expect(decideCommand(policy, "npm test -- auth.test.ts")).toBe("allow");
    });

    it("still denies dangerous commands", () => {
      expect(decideCommand(policy, "git push origin main")).toBe("deny");
    });
  });

  describe("ciMode", () => {
    const policy = { ...defaultPolicy("E:/project/app"), ciMode: true };

    it("denies write in CI mode", () => {
      expect(decideFileWrite(policy, "E:/project/app/src/index.ts")).toBe("deny");
    });

    it("denies install in CI mode", () => {
      expect(decideCommand(policy, "pnpm install")).toBe("deny");
    });
  });

  describe("read allowlist", () => {
    it("allows files matching read allowlist", () => {
      const policy = {
        ...defaultPolicy("E:/project/app"),
        allowedReadGlobs: ["**/*.ts", "**/*.json"]
      };
      expect(decideFileRead(policy, "E:/project/app/src/index.ts")).toBe("allow");
      expect(decideFileRead(policy, "E:/project/app/package.json")).toBe("allow");
    });

    it("denies files not matching read allowlist", () => {
      const policy = {
        ...defaultPolicy("E:/project/app"),
        allowedReadGlobs: ["**/*.ts"]
      };
      expect(decideFileRead(policy, "E:/project/app/README.md")).toBe("deny");
    });

    it("still denies secret files even with allowlist", () => {
      const policy = {
        ...defaultPolicy("E:/project/app"),
        allowedReadGlobs: ["**/*"]
      };
      expect(decideFileRead(policy, "E:/project/app/.env")).toBe("deny");
    });
  });

  describe("write allowlist", () => {
    it("allows files matching write allowlist", () => {
      const policy = {
        ...defaultPolicy("E:/project/app"),
        allowedWriteGlobs: ["**/src/**/*.ts"]
      };
      expect(decideFileWrite(policy, "E:/project/app/src/index.ts")).toBe("ask");
    });

    it("denies files not matching write allowlist", () => {
      const policy = {
        ...defaultPolicy("E:/project/app"),
        allowedWriteGlobs: ["**/src/**/*.ts"]
      };
      expect(decideFileWrite(policy, "E:/project/app/package.json")).toBe("deny");
    });
  });

  describe("terminal args in policy", () => {
    it("allows npm test with args", () => {
      const policy = defaultPolicy("E:/project/app");
      expect(decideCommand(policy, "npm test -- auth.test.ts")).toBe("allow");
    });

    it("denies git push with args", () => {
      const policy = defaultPolicy("E:/project/app");
      expect(decideCommand(policy, "git push origin main")).toBe("deny");
    });

    it("denies rm with args", () => {
      const policy = defaultPolicy("E:/project/app");
      expect(decideCommand(policy, "rm -rf dist")).toBe("deny");
    });

    it("asks for npm install with args", () => {
      const policy = defaultPolicy("E:/project/app");
      expect(decideCommand(policy, "npm install express")).toBe("ask");
    });

    it("denies npm install with args in nonInteractive", () => {
      const policy = { ...defaultPolicy("E:/project/app"), nonInteractive: true };
      expect(decideCommand(policy, "npm install express")).toBe("deny");
    });
  });

  describe("config to policy", () => {
    it("applies terminal allow/deny from config", () => {
      const policy = configToPolicy("E:/project/app", {
        terminal: {
          allow: ["npm test*"],
          deny: ["git push*"]
        }
      });
      expect(decideCommand(policy, "npm test")).toBe("allow");
      expect(decideCommand(policy, "git push origin main")).toBe("deny");
    });

    it("applies fileAccess read/write from config", () => {
      const policy = configToPolicy("E:/project/app", {
        fileAccess: {
          read: ["**/src/**/*.ts"],
          write: ["**/src/**/*.ts"],
          deny: ["**/.env*"]
        }
      });
      expect(decideFileRead(policy, "E:/project/app/src/index.ts")).toBe("allow");
      expect(decideFileRead(policy, "E:/project/app/README.md")).toBe("deny");
      expect(decideFileWrite(policy, "E:/project/app/src/index.ts")).toBe("ask");
      expect(decideFileWrite(policy, "E:/project/app/package.json")).toBe("deny");
    });

    it("enables ciMode from config", () => {
      const policy = configToPolicy("E:/project/app", {
        ci: { enabled: true }
      });
      expect(policy.ciMode).toBe(true);
      expect(decideFileWrite(policy, "E:/project/app/src/index.ts")).toBe("deny");
    });

    it("ciMode flag overrides config", () => {
      const policy = configToPolicy("E:/project/app", {
        ci: { enabled: false }
      }, true);
      expect(policy.ciMode).toBe(true);
    });
  });
});
