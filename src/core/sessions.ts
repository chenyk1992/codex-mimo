import fs from "node:fs";
import path from "node:path";

interface SessionEntry {
  sessionId: string;
  workflow: string;
  task: string;
  cwd: string;
  createdAt: string;
  lastUsedAt: string;
}

export class SessionStore {
  private storePath: string;
  private sessions: SessionEntry[];

  constructor(cwd: string) {
    const storeDir = path.join(cwd, ".codex-mimo");
    fs.mkdirSync(storeDir, { recursive: true });
    this.storePath = path.join(storeDir, "sessions.json");
    this.sessions = this.load();
  }

  save(entry: Omit<SessionEntry, "createdAt" | "lastUsedAt">): void {
    const now = new Date().toISOString();
    const existing = this.sessions.find((s) => s.sessionId === entry.sessionId);
    if (existing) {
      existing.lastUsedAt = now;
      existing.task = entry.task;
    } else {
      this.sessions.push({ ...entry, createdAt: now, lastUsedAt: now });
    }
    this.persist();
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.find((s) => s.sessionId === sessionId);
  }

  list(): SessionEntry[] {
    return [...this.sessions].sort(
      (a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime()
    );
  }

  remove(sessionId: string): boolean {
    const idx = this.sessions.findIndex((s) => s.sessionId === sessionId);
    if (idx === -1) return false;
    this.sessions.splice(idx, 1);
    this.persist();
    return true;
  }

  private load(): SessionEntry[] {
    try {
      const raw = fs.readFileSync(this.storePath, "utf-8");
      return JSON.parse(raw) as SessionEntry[];
    } catch {
      return [];
    }
  }

  private persist(): void {
    fs.writeFileSync(this.storePath, JSON.stringify(this.sessions, null, 2), "utf-8");
  }
}
