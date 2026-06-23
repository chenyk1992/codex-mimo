import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../../src/core/sessions.js";

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-sessions-edge-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("sessions edge cases", () => {
  it("5.34: save + get round-trip", () => {
    const cwd = tempWorkspace();
    const store = new SessionStore(cwd);

    store.save({
      sessionId: "sess_1",
      workflow: "dev",
      task: "Implement auth",
      cwd,
      parentJobId: null
    });

    const session = store.get("sess_1");
    expect(session).toBeDefined();
    expect(session?.sessionId).toBe("sess_1");
    expect(session?.workflow).toBe("dev");
    expect(session?.task).toBe("Implement auth");
  });

  it("5.35: save existing → upsert", () => {
    const cwd = tempWorkspace();
    const store = new SessionStore(cwd);

    store.save({
      sessionId: "sess_1",
      workflow: "dev",
      task: "Original task",
      cwd,
      parentJobId: null
    });

    store.save({
      sessionId: "sess_1",
      workflow: "fix",
      task: "Updated task",
      cwd,
      parentJobId: null
    });

    const session = store.get("sess_1");
    expect(session?.workflow).toBe("fix");
    expect(session?.task).toBe("Updated task");
  });

  it("5.36: list sorted by lastUsedAt", () => {
    const cwd = tempWorkspace();
    const store = new SessionStore(cwd);

    store.save({
      sessionId: "sess_1",
      workflow: "dev",
      task: "First",
      cwd,
      parentJobId: null
    });

    store.save({
      sessionId: "sess_2",
      workflow: "dev",
      task: "Second",
      cwd,
      parentJobId: null
    });

    store.save({
      sessionId: "sess_1",
      workflow: "dev",
      task: "First updated",
      cwd,
      parentJobId: null
    });

    const list = store.list();
    expect(list[0].sessionId).toBe("sess_1");
    expect(list[1].sessionId).toBe("sess_2");
  });

  it("5.37: remove deletes and persists", () => {
    const cwd = tempWorkspace();
    const store = new SessionStore(cwd);

    store.save({
      sessionId: "sess_1",
      workflow: "dev",
      task: "To remove",
      cwd,
      parentJobId: null
    });

    const removed = store.remove("sess_1");
    expect(removed).toBe(true);
    expect(store.get("sess_1")).toBeUndefined();

    const store2 = new SessionStore(cwd);
    expect(store2.get("sess_1")).toBeUndefined();
  });
});
