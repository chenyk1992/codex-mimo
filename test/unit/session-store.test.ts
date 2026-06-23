import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../../src/core/sessions.js";

describe("session store job linkage", () => {
  it("persists job metadata with session entries", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-session-store-"));
    const store = new SessionStore(cwd);

    store.save({
      sessionId: "sess_1",
      workflow: "dev",
      task: "Implement login throttling",
      cwd,
      jobId: "compose-1",
      parentJobId: null,
      status: "completed",
      reportPaths: { json: "report.json" },
      summary: "dev passed"
    });

    expect(store.get("sess_1")).toMatchObject({
      jobId: "compose-1",
      status: "completed",
      summary: "dev passed"
    });
  });
});
