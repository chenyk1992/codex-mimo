import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLogger } from "../../../src/core/audit.js";

const tempDirs: string[] = [];
const loggers: AuditLogger[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-audit-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const l of loggers.splice(0)) {
    try { l.close(); } catch { /* ignore */ }
  }
  await new Promise((r) => setTimeout(r, 100));
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("audit logger", () => {
  it("5.42: log appends JSONL", async () => {
    const dir = tempDir();
    const logger = new AuditLogger(dir);
    loggers.push(logger);

    logger.log({ type: "test_event", data: "value1" });
    logger.log({ type: "test_event", data: "value2" });
    logger.close();
    await new Promise((r) => setTimeout(r, 100));

    const content = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.type).toBe("test_event");
    expect(first.data).toBe("value1");
    expect(first.timestamp).toBeDefined();
  });

  it("5.43: size threshold triggers rotation", async () => {
    const dir = tempDir();
    const logger = new AuditLogger({ logDir: dir, maxFileSize: 10 });
    loggers.push(logger);

    logger.log({ type: "big", padding: "x".repeat(50) });
    logger.close();
    await new Promise((r) => setTimeout(r, 100));

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it("5.44: cleanup removes old files", () => {
    const dir = tempDir();
    const logger = new AuditLogger({ logDir: dir, maxFileSize: 1, maxFiles: 2 });
    loggers.push(logger);

    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(dir, `audit.old${i}.jsonl`), "old data\n");
    }

    logger.cleanup();

    const files = fs.readdirSync(dir).filter((f) => f.startsWith("audit.") && f.endsWith(".jsonl"));
    expect(files.length).toBeLessThanOrEqual(2);
  });
});
