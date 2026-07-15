import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
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
const CLOSE_GRACE_MS = 1_000;
const CLOSE_TERM_WAIT_MS = 1_000;
const CLOSE_KILL_WAIT_MS = 1_000;

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
  private processExited = false;
  private resourcesReleased = false;
  private readonly lines: ReadlineInterface;
  private readonly onLine = (line: string) => this.handleLine(line);
  private readonly onTransportError = () => this.failTransport();
  private readonly onLateError = (): void => undefined;
  private readonly onExit = () => {
    this.processExited = true;
    this.failTransport("Codex App Server exited");
  };

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", this.onLine);
    this.lines.on("error", this.onTransportError);
    child.stderr.resume();
    child.on("error", this.onTransportError);
    child.stdin.on("error", this.onTransportError);
    child.stdout.on("error", this.onTransportError);
    child.stderr.on("error", this.onTransportError);
    child.once("exit", this.onExit);
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
    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    this.closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    void this.closeProcess().then(resolveClose, rejectClose);
    return this.closePromise;
  }

  private async closeProcess(): Promise<void> {
    try {
      if (this.hasExited()) return;

      try {
        this.child.stdin.end();
      } catch {}
      if (await this.waitForExit(CLOSE_GRACE_MS)) return;

      this.kill("SIGTERM");
      if (await this.waitForExit(CLOSE_TERM_WAIT_MS)) return;

      this.kill("SIGKILL");
      await this.waitForExit(CLOSE_KILL_WAIT_MS);
    } finally {
      this.releaseResources();
    }
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
        this.failTransport();
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: unknown): void {
    if (this.terminalError || this.hasExited() || !this.child.stdin.writable) {
      throw new CodexAppServerError("transport", "Codex App Server transport failed");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.failProtocol();
      return;
    }
    if (!isRecord(parsed)) {
      this.failProtocol();
      return;
    }
    if (!hasOwn(parsed, "id")) {
      if (!isNotification(parsed)) this.failProtocol();
      return;
    }
    const response = parsed as unknown as RpcResponse;
    if (!Number.isInteger(response.id)) {
      this.failProtocol();
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) return;

    const hasResult = hasOwn(parsed, "result");
    const hasError = hasOwn(parsed, "error");
    if (hasResult === hasError) {
      this.failProtocol();
      return;
    }
    if (hasResult) {
      if (!isValidResult(pending.method, response.result)) {
        this.failProtocol();
        return;
      }
      this.pending.delete(response.id);
      pending.resolve(response.result);
      return;
    }
    if (!isRpcError(response.error)) {
      this.failProtocol();
      return;
    }

    this.pending.delete(response.id);
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

  private failProtocol(): void {
    this.failAll(new CodexAppServerError("protocol", "Invalid Codex App Server response"));
    this.observeTeardown();
  }

  private failTransport(message = "Codex App Server transport failed"): void {
    this.failAll(new CodexAppServerError("transport", message));
    this.observeTeardown();
  }

  private failAll(error: CodexAppServerError): void {
    if (!this.terminalError) this.terminalError = error;
    for (const pending of this.pending.values()) pending.reject(this.terminalError);
    this.pending.clear();
  }

  private hasExited(): boolean {
    if (this.processExited || this.child.exitCode !== null || this.child.signalCode !== null) {
      this.processExited = true;
      return true;
    }
    return false;
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.hasExited()) return Promise.resolve(true);

    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.child.off("exit", finish);
        resolve(this.hasExited());
      };
      const timer = setTimeout(() => {
        this.child.off("exit", finish);
        resolve(this.hasExited());
      }, timeoutMs);
      this.child.once("exit", finish);
    });
  }

  private observeTeardown(): void {
    void this.close().catch(() => undefined);
  }

  private kill(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal);
    } catch {}
  }

  private releaseResources(): void {
    if (this.resourcesReleased) return;
    this.resourcesReleased = true;
    const stillAlive = !this.hasExited();

    this.lines.off("line", this.onLine);
    this.lines.off("error", this.onTransportError);
    try {
      this.lines.close();
    } catch {}

    this.child.off("error", this.onTransportError);
    if (stillAlive) this.child.on("error", this.onLateError);
    this.child.off("exit", this.onExit);
    this.child.stdin.off("error", this.onTransportError);
    if (stillAlive) this.child.stdin.on("error", this.onLateError);
    this.child.stdout.off("error", this.onTransportError);
    if (stillAlive) this.child.stdout.on("error", this.onLateError);
    this.child.stderr.off("error", this.onTransportError);
    if (stillAlive) this.child.stderr.on("error", this.onLateError);

    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      try {
        stream.destroy();
      } catch {}
    }

    if (stillAlive) {
      try {
        this.child.unref();
      } catch {}
    }
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

function isValidResult(method: string, result: unknown): boolean {
  if (method === "initialize") return isInitializeResult(result);
  if (method === "thread/resume") return isThreadResumeResult(result);
  if (method === "turn/start") return isTurnStartResult(result);
  return false;
}

function isInitializeResult(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.codexHome === "string" &&
    typeof value.platformFamily === "string" &&
    typeof value.platformOs === "string" &&
    typeof value.userAgent === "string";
}

function isThreadResumeResult(value: unknown): boolean {
  const responseKeys = [
    "approvalPolicy",
    "approvalsReviewer",
    "cwd",
    "model",
    "modelProvider",
    "sandbox",
    "thread"
  ];
  if (!isRecord(value) || !hasKeys(value, responseKeys) || !isRecord(value.thread)) return false;

  const threadKeys = [
    "cliVersion",
    "createdAt",
    "cwd",
    "ephemeral",
    "id",
    "modelProvider",
    "preview",
    "sessionId",
    "source",
    "status",
    "turns",
    "updatedAt"
  ];
  return hasKeys(value.thread, threadKeys) &&
    typeof value.thread.id === "string" &&
    Array.isArray(value.thread.turns) &&
    isThreadStatus(value.thread.status);
}

function isTurnStartResult(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.turn)) return false;
  return hasKeys(value.turn, ["id", "items", "status"]) &&
    typeof value.turn.id === "string" &&
    Array.isArray(value.turn.items) &&
    (value.turn.status === "completed" ||
      value.turn.status === "interrupted" ||
      value.turn.status === "failed" ||
      value.turn.status === "inProgress");
}

function isThreadStatus(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "active") {
    return Array.isArray(value.activeFlags) &&
      value.activeFlags.every((flag) => typeof flag === "string");
  }
  return value.type === "idle" || value.type === "notLoaded" || value.type === "systemError";
}

function isRpcError(value: unknown): value is RpcError {
  return isRecord(value) && Number.isInteger(value.code) && typeof value.message === "string";
}

function isNotification(value: Record<string, unknown>): boolean {
  return typeof value.method === "string" &&
    hasOwn(value, "params") &&
    !hasOwn(value, "result") &&
    !hasOwn(value, "error");
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => hasOwn(value, key));
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
