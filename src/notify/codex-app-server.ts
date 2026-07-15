import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { withUtf8ProcessEnv } from "../core/encoding.js";

export interface ThreadResumeResult {
  exists: boolean;
  busy: boolean;
}

export interface CodexAppServerClient {
  initialize(): Promise<void>;
  resumeThread(threadId: string): Promise<ThreadResumeResult>;
  startTurn(threadId: string, prompt: string): Promise<void>;
  close(): Promise<void>;
}

export type CodexAppServerErrorKind = "forbidden" | "protocol" | "transport";

export class CodexAppServerError extends Error {
  constructor(
    public readonly kind: CodexAppServerErrorKind,
    message: string
  ) {
    super(message);
    this.name = "CodexAppServerError";
  }
}

interface RpcError {
  code: number;
  message: string;
}

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: RpcError;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: CodexAppServerError) => void;
}

const MISSING_THREAD = Symbol("missing-thread");

export function createCodexAppServerClient(): CodexAppServerClient {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: withUtf8ProcessEnv()
    });
  } catch {
    throw new CodexAppServerError("transport", "Codex App Server transport failed");
  }

  return new StdioCodexAppServerClient(child);
}

class StdioCodexAppServerClient implements CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private initialized = false;
  private initializePromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private terminalError?: CodexAppServerError;
  private ended = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const failTransport = () => {
      this.ended = true;
      this.failAll(new CodexAppServerError("transport", "Codex App Server transport failed"));
    };
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    lines.on("error", failTransport);
    child.stderr.resume();
    child.once("error", failTransport);
    child.stdin.once("error", failTransport);
    child.stdout.once("error", failTransport);
    child.stderr.once("error", failTransport);
    child.once("exit", () => {
      this.ended = true;
      this.failAll(new CodexAppServerError("transport", "Codex App Server exited"));
    });
  }

  initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.request("initialize", {
      clientInfo: {
        name: "codex_mimo",
        title: "Codex MiMoCode Bridge",
        version: "0.1.0"
      }
    }).then(() => {
      this.notify("initialized", {});
      this.initialized = true;
    });
    return this.initializePromise;
  }

  async resumeThread(threadId: string): Promise<ThreadResumeResult> {
    this.requireInitialized();
    const result = await this.request("thread/resume", { threadId });
    if (result === MISSING_THREAD) return { exists: false, busy: false };

    const status = readThreadStatus(result);
    if (status === "idle") return { exists: true, busy: false };
    if (status === "active" || status === "notLoaded") {
      return { exists: true, busy: true };
    }
    throw new CodexAppServerError("protocol", "Codex thread is unavailable");
  }

  async startTurn(threadId: string, prompt: string): Promise<void> {
    this.requireInitialized();
    await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }]
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeProcess();
    return this.closePromise;
  }

  private async closeProcess(): Promise<void> {
    if (this.ended || this.child.exitCode !== null || this.child.signalCode !== null) return;

    await new Promise<void>((resolve, reject) => {
      const finish = () => resolve();
      const fail = () => reject(
        new CodexAppServerError("transport", "Codex App Server transport failed")
      );
      this.child.once("exit", finish);
      this.child.once("error", fail);
      this.child.stdin.end((error?: Error | null) => {
        if (error) fail();
      });
    });
  }

  private requireInitialized(): void {
    if (this.terminalError) throw this.terminalError;
    if (!this.initialized) {
      throw new CodexAppServerError("protocol", "Codex App Server is not initialized");
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.terminalError) return Promise.reject(this.terminalError);

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      try {
        this.write({ method, id, params });
      } catch {
        const error = new CodexAppServerError("transport", "Codex App Server transport failed");
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: unknown): void {
    if (this.terminalError || this.ended || !this.child.stdin.writable) {
      throw new CodexAppServerError("transport", "Codex App Server transport failed");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const response = parsed as unknown as RpcResponse;
    if (!Number.isInteger(response.id)) return;

    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);

    if (!response.error) {
      pending.resolve(response.result);
      return;
    }
    if (pending.method === "thread/resume" && isMissingThreadError(response.error)) {
      pending.resolve(MISSING_THREAD);
      return;
    }
    if (pending.method === "thread/resume" && isForbiddenThreadError(response.error)) {
      pending.reject(new CodexAppServerError("forbidden", "Codex thread is forbidden"));
      return;
    }
    pending.reject(new CodexAppServerError("protocol", "Codex App Server request failed"));
  }

  private failAll(error: CodexAppServerError): void {
    if (!this.terminalError) this.terminalError = error;
    for (const pending of this.pending.values()) pending.reject(this.terminalError);
    this.pending.clear();
  }
}

function readThreadStatus(result: unknown): "active" | "idle" | "notLoaded" | "systemError" {
  if (!isRecord(result) || !isRecord(result.thread) || !isRecord(result.thread.status)) {
    throw new CodexAppServerError("protocol", "Invalid Codex thread response");
  }
  const type = result.thread.status.type;
  if (type === "active" || type === "idle" || type === "notLoaded" || type === "systemError") {
    return type;
  }
  throw new CodexAppServerError("protocol", "Invalid Codex thread response");
}

function isMissingThreadError(error: RpcError): boolean {
  return error.code === -32600 && /no rollout found for thread id/i.test(error.message);
}

function isForbiddenThreadError(error: RpcError): boolean {
  return /forbidden|permission denied|access denied|unauthori[sz]ed/i.test(error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
