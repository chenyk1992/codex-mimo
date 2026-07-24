import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_MS = 10;
const PROCESS_LOCK_PORT_START = 20_000;
const PROCESS_LOCK_PORT_COUNT = 10_000;

export interface ProcessLockOptions {
  timeoutMs?: number;
  retryMs?: number;
}

export interface ProcessLockEndpoint {
  host: string;
  port: number;
}

export class ProcessLockUnavailableError extends Error {
  readonly key: string;
  readonly endpoint: ProcessLockEndpoint;

  constructor(key: string, endpoint: ProcessLockEndpoint, cause: unknown) {
    super(`Timed out acquiring process lock at ${endpoint.host}:${endpoint.port}`, { cause });
    this.name = "ProcessLockUnavailableError";
    this.key = key;
    this.endpoint = endpoint;
  }
}

export function resolveProcessLockEndpoint(key: string): ProcessLockEndpoint {
  const canonicalKey = canonicalizeLockKey(key);
  const hash = createHash("sha256").update(canonicalKey, "utf8").digest();
  const octet = (value: number) => (value % 254) + 1;
  return {
    host: `127.${octet(hash[0])}.${octet(hash[1])}.${octet(hash[2])}`,
    port: PROCESS_LOCK_PORT_START + (hash.readUInt16BE(3) % PROCESS_LOCK_PORT_COUNT)
  };
}

export async function withProcessLock<T>(
  key: string,
  action: () => Promise<T> | T,
  options: ProcessLockOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("Process lock timeoutMs must be a non-negative finite number");
  }
  if (!Number.isFinite(retryMs) || retryMs <= 0) {
    throw new Error("Process lock retryMs must be a positive finite number");
  }

  const endpoint = resolveProcessLockEndpoint(key);
  const server = await acquireEndpoint(key, endpoint, timeoutMs, retryMs);
  try {
    return await action();
  } finally {
    await closeServer(server);
  }
}

export async function isProcessLockHeld(key: string): Promise<boolean> {
  const endpoint = resolveProcessLockEndpoint(key);
  try {
    await withProcessLock(key, () => undefined, { timeoutMs: 0 });
    return false;
  } catch (error) {
    if (error instanceof ProcessLockUnavailableError &&
        error.key === key &&
        error.endpoint.host === endpoint.host &&
        error.endpoint.port === endpoint.port) {
      return true;
    }
    throw error;
  }
}

function canonicalizeLockKey(key: string): string {
  let ancestor = path.resolve(key);
  const remaining: string[] = [];
  while (true) {
    try {
      const physicalAncestor = fs.realpathSync.native(ancestor);
      const physicalPath = path.join(physicalAncestor, ...remaining);
      return process.platform === "win32" ? physicalPath.toLowerCase() : physicalPath;
    } catch (error) {
      if (!isErrorWithCode(error, "ENOENT") && !isErrorWithCode(error, "ENOTDIR")) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      remaining.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

async function acquireEndpoint(
  key: string,
  endpoint: ProcessLockEndpoint,
  timeoutMs: number,
  retryMs: number
): Promise<net.Server> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await listen(endpoint);
    } catch (error) {
      if (!isErrorWithCode(error, "EADDRINUSE")) throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new ProcessLockUnavailableError(key, endpoint, error);
      }
      await delay(Math.min(retryMs, remainingMs));
    }
  }
}

function listen(endpoint: ProcessLockEndpoint): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: endpoint.host, port: endpoint.port, exclusive: true });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
