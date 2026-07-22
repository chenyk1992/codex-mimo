import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { withUtf8ProcessEnv } from "../core/encoding.js";
import {
  codexCommandErrorCode,
  resolveCodexCommand,
  type CodexCommandSelection
} from "./codex-command.js";
import type { NotificationErrorCode } from "./types.js";

export interface ThreadResumeResult {
  exists: boolean;
  busy: boolean;
}

export type CodexTurnTerminalStatus = "completed" | "interrupted" | "failed";

export interface CodexTurnCompletion {
  turnId: string;
  status: CodexTurnTerminalStatus;
}

export interface CodexAppServerClient {
  initialize(signal?: AbortSignal): Promise<void>;
  resumeThread(threadId: string, signal?: AbortSignal): Promise<ThreadResumeResult>;
  startTurnAndWait(
    threadId: string,
    prompt: string,
    signal?: AbortSignal
  ): Promise<CodexTurnCompletion>;
  close(): Promise<void>;
}

export class CodexAppServerError extends Error {
  constructor(
    public readonly code: NotificationErrorCode,
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
  cleanup: () => void;
}

const MISSING_THREAD = Symbol("missing-thread");
const CLOSE_GRACE_MS = 1_000;
const CLOSE_TERM_WAIT_MS = 1_000;
const CLOSE_KILL_WAIT_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TURN_COMPLETION_TIMEOUT_MS = 300_000;

export interface CodexAppServerClientOptions {
  spawnProcess?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  command?: CodexCommandSelection;
  requestTimeoutMs?: number;
  scheduleRequestTimeout?: (callback: () => void, delayMs: number) => unknown;
  cancelRequestTimeout?: (timer: unknown) => void;
  turnCompletionTimeoutMs?: number;
  scheduleTurnCompletionTimeout?: (callback: () => void, delayMs: number) => unknown;
  cancelTurnCompletionTimeout?: (timer: unknown) => void;
}

export function createCodexAppServerClient(
  options: CodexAppServerClientOptions = {}
): CodexAppServerClient {
  const processEnv = options.env ?? process.env;
  const command = options.command ?? resolveCodexCommand(processEnv);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (options.spawnProcess ?? spawn)(
      command.command,
      ["app-server", "--listen", "stdio://"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: withUtf8ProcessEnv(processEnv)
      }
    ) as ChildProcessWithoutNullStreams;
  } catch (error) {
    const code = codexCommandErrorCode(error);
    throw new CodexAppServerError(code, safeCodexErrorMessage(code));
  }

  return new StdioCodexAppServerClient(child, options);
}

class StdioCodexAppServerClient implements CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly terminalTurns = new Map<string, CodexTurnCompletion & { threadId: string }>();
  private readonly turnWaiters = new Map<string, {
    threadId: string;
    resolve: (completion: CodexTurnCompletion) => void;
    reject: (error: CodexAppServerError) => void;
    cleanup: () => void;
  }>();
  private initialized = false;
  private initializePromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private terminalError?: CodexAppServerError;
  private processExited = false;
  private resourcesReleased = false;
  private readonly lines: ReadlineInterface;
  private readonly onLine = (line: string) => this.handleLine(line);
  private readonly onTransportError = (cause?: unknown) => this.failTransport(cause);
  private readonly onLateError = (): void => undefined;
  private readonly onExit = () => {
    this.processExited = true;
    this.failTransport(undefined, "Codex App Server exited");
  };

  private readonly requestTimeoutMs: number;
  private readonly scheduleRequestTimeout: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelRequestTimeout: (timer: unknown) => void;
  private readonly turnCompletionTimeoutMs: number;
  private readonly scheduleTurnCompletionTimeout: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelTurnCompletionTimeout: (timer: unknown) => void;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    options: CodexAppServerClientOptions
  ) {
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.scheduleRequestTimeout = options.scheduleRequestTimeout ?? defaultScheduleRequestTimeout;
    this.cancelRequestTimeout = options.cancelRequestTimeout ?? defaultCancelRequestTimeout;
    this.turnCompletionTimeoutMs = Math.max(
      1,
      options.turnCompletionTimeoutMs ?? DEFAULT_TURN_COMPLETION_TIMEOUT_MS
    );
    this.scheduleTurnCompletionTimeout =
      options.scheduleTurnCompletionTimeout ?? defaultScheduleTurnCompletionTimeout;
    this.cancelTurnCompletionTimeout =
      options.cancelTurnCompletionTimeout ?? defaultCancelTurnCompletionTimeout;
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

  initialize(signal?: AbortSignal): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.request("initialize", {
      clientInfo: {
        name: "codex_mimo",
        title: "Codex MiMoCode Bridge",
        version: "0.1.0"
      }
    }, signal).then(() => {
      this.notify("initialized", {});
      this.initialized = true;
    });
    return this.initializePromise;
  }

  async resumeThread(threadId: string, signal?: AbortSignal): Promise<ThreadResumeResult> {
    this.requireInitialized();
    const result = await this.request("thread/resume", { threadId }, signal);
    if (result === MISSING_THREAD) return { exists: false, busy: false };

    const status = readThreadStatus(result);
    if (status === "idle") return { exists: true, busy: false };
    if (status === "active" || status === "notLoaded") {
      return { exists: true, busy: true };
    }
    throw new CodexAppServerError(
      "codex_app_server_incompatible",
      "Codex thread is unavailable"
    );
  }

  async startTurnAndWait(
    threadId: string,
    prompt: string,
    signal?: AbortSignal
  ): Promise<CodexTurnCompletion> {
    this.requireInitialized();
    const result = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }]
    }, signal);
    const started = readTurnStart(result);
    if (isTerminalTurnStatus(started.status)) {
      return { turnId: started.turnId, status: started.status };
    }
    return this.waitForTurnCompletion(threadId, started.turnId, signal);
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
      throw new CodexAppServerError(
        "codex_app_server_incompatible",
        "Codex App Server is not initialized"
      );
    }
  }

  private waitForTurnCompletion(
    threadId: string,
    turnId: string,
    signal?: AbortSignal
  ): Promise<CodexTurnCompletion> {
    if (signal?.aborted) {
      this.failTransport();
      return Promise.reject(this.terminalError!);
    }
    const buffered = this.terminalTurns.get(turnId);
    if (buffered?.threadId === threadId) {
      this.terminalTurns.delete(turnId);
      return Promise.resolve({ turnId, status: buffered.status });
    }
    return new Promise((resolve, reject) => {
      let timer: unknown;
      let cleaned = false;
      const onAbort = () => this.failTransport();
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        this.cancelTurnCompletionTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = this.scheduleTurnCompletionTimeout(() => {
        this.failAll(new CodexAppServerError(
          "codex_turn_timeout",
          "Codex callback turn timed out"
        ));
        this.observeTeardown();
      }, this.turnCompletionTimeoutMs);
      this.turnWaiters.set(turnId, {
        threadId,
        resolve: (completion) => {
          cleanup();
          this.turnWaiters.delete(turnId);
          resolve(completion);
        },
        reject: (error) => {
          cleanup();
          this.turnWaiters.delete(turnId);
          reject(error);
        },
        cleanup
      });
    });
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (signal?.aborted) {
      this.failTransport();
      return Promise.reject(this.terminalError!);
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer: unknown;
      const onAbort = () => this.failTransport();
      const cleanup = () => {
        this.cancelRequestTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = this.scheduleRequestTimeout(() => this.failTransport(), this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, cleanup });
      try {
        appendRpcAudit(method, params);
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
      throw new CodexAppServerError(
        "codex_app_server_unavailable",
        "Codex App Server transport failed"
      );
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
      if (!isNotification(parsed)) {
        this.failProtocol();
        return;
      }
      this.handleNotification(parsed);
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
      pending.cleanup();
      pending.resolve(response.result);
      return;
    }
    if (!isRpcError(response.error)) {
      this.failProtocol();
      return;
    }

    this.pending.delete(response.id);
    pending.cleanup();
    if (pending.method === "thread/resume" && isMissingThreadError(response.error)) {
      pending.resolve(MISSING_THREAD);
      return;
    }
    if (pending.method === "thread/resume" && isForbiddenThreadError(response.error)) {
      pending.reject(new CodexAppServerError(
        "codex_thread_forbidden",
        "Codex thread is forbidden"
      ));
      return;
    }
    pending.reject(new CodexAppServerError(
      "codex_app_server_incompatible",
      "Codex App Server request failed"
    ));
  }

  private handleNotification(notification: Record<string, unknown>): void {
    if (notification.method !== "turn/completed") return;
    const completion = readTurnCompletedNotification(notification);
    if (!completion) {
      this.failProtocol();
      return;
    }
    const waiter = this.turnWaiters.get(completion.turnId);
    if (!waiter) {
      this.terminalTurns.set(completion.turnId, completion);
      return;
    }
    if (waiter.threadId !== completion.threadId) return;
    waiter.resolve({ turnId: completion.turnId, status: completion.status });
  }

  private failProtocol(): void {
    this.failAll(new CodexAppServerError(
      "codex_app_server_incompatible",
      "Codex App Server protocol is incompatible"
    ));
    this.observeTeardown();
  }

  private failTransport(cause?: unknown, message?: string): void {
    const code = cause !== undefined
      ? codexCommandErrorCode(cause)
      : "codex_app_server_unavailable";
    this.failAll(new CodexAppServerError(code, message ?? safeCodexErrorMessage(code)));
    this.observeTeardown();
  }

  private failAll(error: CodexAppServerError): void {
    if (!this.terminalError) this.terminalError = error;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(this.terminalError);
    }
    this.pending.clear();
    for (const [turnId, waiter] of this.turnWaiters) {
      waiter.cleanup();
      waiter.reject(this.terminalError);
      this.turnWaiters.delete(turnId);
    }
    this.terminalTurns.clear();
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

function appendRpcAudit(
  method: string,
  params: unknown,
  env: NodeJS.ProcessEnv = process.env
): void {
  const file = env.CODEX_MIMO_APP_SERVER_AUDIT_FILE?.trim();
  if (!file) return;

  const threadId = readAuditableThreadId(method, params);
  const record = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    method,
    ...(threadId === undefined ? {} : { threadId })
  };
  try {
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
  } catch {}
}

function readAuditableThreadId(method: string, params: unknown): string | undefined {
  if (method !== "thread/resume" && method !== "turn/start") return undefined;
  if (!isRecord(params)) return undefined;
  const threadId = params.threadId;
  return typeof threadId === "string" && threadId.trim() !== "" ? threadId : undefined;
}

function readThreadStatus(result: unknown): "active" | "idle" | "notLoaded" | "systemError" {
  if (!isRecord(result) || !isRecord(result.thread) || !isRecord(result.thread.status)) {
    throw new CodexAppServerError(
      "codex_app_server_incompatible",
      "Invalid Codex thread response"
    );
  }
  const type = result.thread.status.type;
  if (type === "active" || type === "idle" || type === "notLoaded" || type === "systemError") {
    return type;
  }
  throw new CodexAppServerError(
    "codex_app_server_incompatible",
    "Invalid Codex thread response"
  );
}

function safeCodexErrorMessage(code: NotificationErrorCode): string {
  switch (code) {
    case "codex_cli_not_found":
    case "codex_cli_not_executable":
      return "Codex App Server executable is unavailable";
    case "codex_app_server_incompatible":
      return "Codex App Server protocol is incompatible";
    case "codex_thread_forbidden":
      return "Codex thread is forbidden";
    case "codex_thread_missing":
      return "Codex thread does not exist";
    case "codex_thread_busy":
      return "Codex thread is busy";
    case "codex_app_server_unavailable":
      return "Codex App Server request failed";
    case "codex_turn_interrupted":
      return "Codex callback turn was interrupted";
    case "codex_turn_failed":
      return "Codex callback turn failed";
    case "codex_turn_timeout":
      return "Codex callback turn timed out";
  }
}

function readTurnStart(
  value: unknown
): { turnId: string; status: "inProgress" | CodexTurnTerminalStatus } {
  if (!isTurnStartResult(value)) {
    throw new CodexAppServerError(
      "codex_app_server_incompatible",
      "Invalid Codex turn response"
    );
  }
  const turn = (value as { turn: { id: string; status: string } }).turn;
  return {
    turnId: turn.id,
    status: turn.status as "inProgress" | CodexTurnTerminalStatus
  };
}

function isTerminalTurnStatus(value: string): value is CodexTurnTerminalStatus {
  return value === "completed" || value === "interrupted" || value === "failed";
}

function isMissingThreadError(error: RpcError): boolean {
  return error.code === -32600 && /no rollout found for thread id/i.test(error.message);
}

function isForbiddenThreadError(error: RpcError): boolean {
  return /forbidden|permission denied|access denied|unauthori[sz]ed/i.test(error.message);
}

function defaultScheduleRequestTimeout(
  callback: () => void,
  delayMs: number
): ReturnType<typeof setTimeout> {
  return setTimeout(callback, delayMs);
}

function defaultCancelRequestTimeout(timer: unknown): void {
  clearTimeout(timer as ReturnType<typeof setTimeout>);
}

function defaultScheduleTurnCompletionTimeout(
  callback: () => void,
  delayMs: number
): ReturnType<typeof setTimeout> {
  return setTimeout(callback, delayMs);
}

function defaultCancelTurnCompletionTimeout(timer: unknown): void {
  clearTimeout(timer as ReturnType<typeof setTimeout>);
}

function readTurnCompletedNotification(value: Record<string, unknown>):
  | (CodexTurnCompletion & { threadId: string })
  | undefined {
  if (!isRecord(value.params) ||
      typeof value.params.threadId !== "string" ||
      !isRecord(value.params.turn) ||
      typeof value.params.turn.id !== "string" ||
      typeof value.params.turn.status !== "string" ||
      !isTerminalTurnStatus(value.params.turn.status)) {
    return undefined;
  }
  return {
    threadId: value.params.threadId,
    turnId: value.params.turn.id,
    status: value.params.turn.status
  };
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
