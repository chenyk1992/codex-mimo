import { execa } from "execa";
import { withUtf8ProcessEnv } from "../core/encoding.js";
import {
  classifyCodexCommandFailure,
  codexCommandErrorCode,
  discoverCodexCandidates,
  resolveCodexCommand,
  type CodexCommandExecutor,
  type CodexCommandSelection
} from "./codex-command.js";
import {
  CodexAppServerError,
  createCodexAppServerClient,
  type CodexAppServerClient,
  type CodexAppServerClientOptions,
  type ThreadResumeResult
} from "./codex-app-server.js";
import type { NotificationErrorCode } from "./types.js";

export interface PreparedCodexConnection {
  probe: CodexConnectionProbe;
  client?: CodexAppServerClient;
  thread?: ThreadResumeResult;
}

/** Safe target-aware readiness information suitable for public reporting. */
export interface CodexConnectionProbe {
  ok: boolean;
  source: CodexCommandSelection["source"];
  version?: string;
  errorCode?: NotificationErrorCode;
}

export interface PrepareCodexConnectionOptions {
  threadId: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  candidates?: CodexCommandSelection[];
  execute?: CodexCommandExecutor;
  createClient?: (options?: CodexAppServerClientOptions) => CodexAppServerClient;
}

/**
 * Verifies both the executable and the requested existing Codex task. The client
 * is retained only when it is ready for a later notification operation.
 */
export async function prepareCodexConnection(
  options: PrepareCodexConnectionOptions
): Promise<PreparedCodexConnection> {
  const env = options.env ?? process.env;
  const candidates = options.candidates ?? discoverCodexCandidates(env, process.platform);
  if (candidates.length === 0) {
    return {
      probe: {
        ok: false,
        source: resolveCodexCommand(env).source,
        errorCode: "codex_cli_not_found"
      }
    };
  }

  const execute = options.execute ?? ((command, args, executeOptions) =>
    execa(command, args, executeOptions));
  let failure: CodexConnectionProbe | undefined;
  for (const candidate of candidates) {
    const version = await readVersion(
      candidate,
      execute,
      env,
      options.requestTimeoutMs ?? 10_000,
      options.signal
    );
    if (!version.ok) {
      failure = version.probe;
      if (candidate.source === "configured" || !allowsImplicitFallback(failure.errorCode)) {
        return { probe: failure };
      }
      continue;
    }

    const prepared = await prepareCandidate(candidate, version.version, options, env);
    if (prepared.client) return prepared;
    failure = prepared.probe;
    if (candidate.source === "configured" || !allowsImplicitFallback(failure.errorCode)) {
      return { probe: failure };
    }
  }
  return { probe: failure! };
}

async function readVersion(
  candidate: CodexCommandSelection,
  execute: CodexCommandExecutor,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<{ ok: true; version: string } | { ok: false; probe: CodexConnectionProbe }> {
  try {
    const result = await execute(candidate.command, ["--version"], {
      env: withUtf8ProcessEnv(env),
      reject: false,
      timeout: timeoutMs,
      ...(signal ? { cancelSignal: signal } : {})
    });
    if (result.exitCode === 0) {
      return { ok: true, version: typeof result.stdout === "string" ? result.stdout.trim() : "" };
    }
    return {
      ok: false,
      probe: {
        ok: false,
        source: candidate.source,
        errorCode: classifyCodexCommandFailure(result, candidate.command)
      }
    };
  } catch (error) {
    return {
      ok: false,
      probe: {
        ok: false,
        source: candidate.source,
        errorCode: classifyCodexCommandFailure(error, candidate.command)
      }
    };
  }
}

async function prepareCandidate(
  candidate: CodexCommandSelection,
  version: string,
  options: PrepareCodexConnectionOptions,
  env: NodeJS.ProcessEnv
): Promise<PreparedCodexConnection> {
  let client: CodexAppServerClient | undefined;
  try {
    client = (options.createClient ?? createCodexAppServerClient)({
      env,
      command: candidate,
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs })
    });
    await client.initialize(options.signal);
    const thread = await client.resumeThread(options.threadId, options.signal);
    if (thread.exists) {
      const prepared = client;
      client = undefined;
      return preparedConnection(
        { ok: true, source: candidate.source, version },
        prepared,
        thread
      );
    }
    return { probe: { ok: false, source: candidate.source, errorCode: "codex_thread_missing" } };
  } catch (error) {
    return {
      probe: {
        ok: false,
        source: candidate.source,
        errorCode: safeConnectionErrorCode(error)
      }
    };
  } finally {
    if (client) await closeRejectedClient(client);
  }
}

function safeConnectionErrorCode(error: unknown): NotificationErrorCode {
  return error instanceof CodexAppServerError
    ? error.code
    : codexCommandErrorCode(error);
}

function allowsImplicitFallback(code: NotificationErrorCode | undefined): boolean {
  return code === "codex_cli_not_found" ||
    code === "codex_cli_not_executable" ||
    code === "codex_app_server_unavailable" ||
    code === "codex_app_server_incompatible";
}

async function closeRejectedClient(client: CodexAppServerClient): Promise<void> {
  try {
    await client.close();
  } catch {
    // Probe errors must not be overwritten by best-effort cleanup failures.
  }
}

function preparedConnection(
  probe: CodexConnectionProbe,
  client: CodexAppServerClient,
  thread: ThreadResumeResult
): PreparedCodexConnection {
  const prepared: PreparedCodexConnection = { probe };
  Object.defineProperty(prepared, "client", { value: client });
  Object.defineProperty(prepared, "thread", { value: thread });
  return prepared;
}
