import { describe, expect, it } from "vitest";
import { getComposeWorkflow } from "../../../src/compose/workflow.js";

describe("workflow validation", () => {
  it("brainstorm: requiresTask=true, writesAllowed=false", () => {
    const workflow = getComposeWorkflow("brainstorm");
    expect(workflow.requiresTask).toBe(true);
    expect(workflow.writesAllowed).toBe(false);
    expect(workflow.requiresFile).toBe(false);
  });

  it("dev: requiresTask=true, writesAllowed=true", () => {
    const workflow = getComposeWorkflow("dev");
    expect(workflow.requiresTask).toBe(true);
    expect(workflow.writesAllowed).toBe(true);
    expect(workflow.requiresFile).toBe(false);
  });

  it("fix-ci: requiresFile=true, requiresTask=false", () => {
    const workflow = getComposeWorkflow("fix-ci");
    expect(workflow.requiresFile).toBe(true);
    expect(workflow.requiresTask).toBe(false);
    expect(workflow.writesAllowed).toBe(true);
  });

  it("review: requiresTask=false, requiresFile=false", () => {
    const workflow = getComposeWorkflow("review");
    expect(workflow.requiresTask).toBe(false);
    expect(workflow.requiresFile).toBe(false);
    expect(workflow.writesAllowed).toBe(false);
  });

  it("plan: requiresTask=true, writesAllowed=false", () => {
    const workflow = getComposeWorkflow("plan");
    expect(workflow.requiresTask).toBe(true);
    expect(workflow.writesAllowed).toBe(false);
    expect(workflow.requiresFile).toBe(false);
  });

  it("execute-plan: requiresFile=true, writesAllowed=true", () => {
    const workflow = getComposeWorkflow("execute-plan");
    expect(workflow.requiresFile).toBe(true);
    expect(workflow.writesAllowed).toBe(true);
    expect(workflow.requiresTask).toBe(false);
  });
});
