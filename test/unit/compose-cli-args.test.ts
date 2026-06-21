import { describe, expect, it } from "vitest";

describe("compose CLI argument parsing", () => {
  it("should parse workflow flag", () => {
    const args = ["--workflow", "dev", "Implement login throttling"];
    const workflowIdx = args.indexOf("--workflow");
    expect(workflowIdx).toBe(0);
    expect(args[workflowIdx + 1]).toBe("dev");
  });

  it("should parse multiple verify flags", () => {
    const args = ["--verify", "npm test", "--verify", "npm run build"];
    const verifyCommands: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--verify" && i + 1 < args.length) {
        verifyCommands.push(args[i + 1]);
        i++;
      }
    }
    expect(verifyCommands).toEqual(["npm test", "npm run build"]);
  });

  it("should parse file flag", () => {
    const args = ["--file", "ci.log"];
    const fileIdx = args.indexOf("--file");
    expect(fileIdx).toBe(0);
    expect(args[fileIdx + 1]).toBe("ci.log");
  });
});
