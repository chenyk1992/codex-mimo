import fs from "node:fs";
import path from "node:path";

export interface AuditEvent {
  type: string;
  [key: string]: unknown;
}

export interface AuditLoggerOptions {
  logDir: string;
  maxFileSize?: number;
  maxFiles?: number;
}

export class AuditLogger {
  private stream: fs.WriteStream;
  private logDir: string;
  private logPath: string;
  private maxFileSize: number;
  private maxFiles: number;
  private currentSize: number;

  constructor(options: AuditLoggerOptions | string) {
    const opts = typeof options === "string" ? { logDir: options } : options;
    this.logDir = opts.logDir;
    this.logPath = path.join(this.logDir, "audit.jsonl");
    this.maxFileSize = opts.maxFileSize ?? 10 * 1024 * 1024;
    this.maxFiles = opts.maxFiles ?? 5;

    fs.mkdirSync(this.logDir, { recursive: true });
    this.currentSize = this.getFileSize(this.logPath);
    this.stream = fs.createWriteStream(this.logPath, { flags: "a" });
  }

  log(event: AuditEvent): void {
    const line = JSON.stringify({ ...event, timestamp: new Date().toISOString() }) + "\n";
    this.currentSize += Buffer.byteLength(line);

    if (this.currentSize > this.maxFileSize) {
      this.rotate();
    }

    this.stream.write(line);
  }

  close(): void {
    this.stream.end();
  }

  cleanup(): void {
    const files = this.getRotatedFiles();
    while (files.length >= this.maxFiles) {
      const oldest = files.shift();
      if (oldest) {
        try { fs.unlinkSync(oldest); } catch { /* ignore */ }
      }
    }
  }

  private rotate(): void {
    this.stream.end();
    const files = this.getRotatedFiles();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rotatedPath = path.join(this.logDir, `audit.${timestamp}.jsonl`);

    try { fs.renameSync(this.logPath, rotatedPath); } catch { /* ignore */ }

    this.cleanup();
    this.currentSize = 0;
    this.stream = fs.createWriteStream(this.logPath, { flags: "a" });
  }

  private getRotatedFiles(): string[] {
    try {
      return fs.readdirSync(this.logDir)
        .filter((f) => f.startsWith("audit.") && f.endsWith(".jsonl"))
        .sort()
        .map((f) => path.join(this.logDir, f));
    } catch {
      return [];
    }
  }

  private getFileSize(filePath: string): number {
    try { return fs.statSync(filePath).size; } catch { return 0; }
  }
}
