import { describe, expect, it } from "vitest";
import { classifyEffectiveProgress } from "../../../src/core/job-progress.js";

describe("classifyEffectiveProgress", () => {
  it("does not treat reasoning or plain text as progress", () => {
    expect(classifyEffectiveProgress({
      previousFingerprint: undefined,
      event: { type: "reasoning", text: "thinking" }
    }).progressed).toBe(false);
    expect(classifyEffectiveProgress({
      previousFingerprint: undefined,
      event: { type: "text", text: "hello" }
    }).progressed).toBe(false);
  });

  it("advances on a new tool_use fingerprint and ignores duplicates", () => {
    const first = classifyEffectiveProgress({
      previousFingerprint: undefined,
      event: {
        type: "tool_use",
        tool: "bash",
        command: "npm test",
        phase: "started"
      }
    });
    expect(first.progressed).toBe(true);
    expect(first.kind).toBe("tool_start");
    expect(first.lastCommand).toMatch(/npm test/);

    const dup = classifyEffectiveProgress({
      previousFingerprint: first.fingerprint,
      event: {
        type: "tool_use",
        tool: "bash",
        command: "npm test",
        phase: "started"
      }
    });
    expect(dup.progressed).toBe(false);
  });

  it("advances on write/edit path changes and phase changes", () => {
    expect(classifyEffectiveProgress({
      previousFingerprint: undefined,
      event: { type: "tool_use", tool: "write", filePath: "src/a.ts", phase: "finished" }
    })).toMatchObject({ progressed: true, kind: "file_change" });

    expect(classifyEffectiveProgress({
      previousFingerprint: undefined,
      event: { type: "phase", phase: "editing" }
    })).toMatchObject({ progressed: true, kind: "phase_change" });
  });
});
