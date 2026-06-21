export type LogLevel = "debug" | "info" | "warn" | "error";

const levelPriority: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

export class Logger {
  private level: LogLevel;

  constructor(level: LogLevel = "info") {
    this.level = level;
  }

  debug(msg: string, data?: unknown): void {
    this.log("debug", msg, data);
  }

  info(msg: string, data?: unknown): void {
    this.log("info", msg, data);
  }

  warn(msg: string, data?: unknown): void {
    this.log("warn", msg, data);
  }

  error(msg: string, data?: unknown): void {
    this.log("error", msg, data);
  }

  private log(level: LogLevel, msg: string, data?: unknown): void {
    if (levelPriority[level] < levelPriority[this.level]) return;
    const entry = { level, msg, ts: new Date().toISOString(), ...(data ? { data } : {}) };
    const stream = level === "error" ? process.stderr : process.stdout;
    stream.write(JSON.stringify(entry) + "\n");
  }
}

export const logger = new Logger();
