export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: {
    fs: { readTextFile: boolean; writeTextFile: boolean };
    terminal: boolean;
  };
  clientInfo: {
    name: string;
    title: string;
    version: string;
  };
}

export interface InitializeResult {
  protocolVersion: number;
  capabilities: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

export interface SessionNewParams {
  cwd: string;
  mcpServers?: unknown[];
}

export interface SessionNewResult {
  sessionId: string;
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: Array<{ type: string; text: string }>;
}

export interface SessionPromptResult {
  stopReason: string;
}

export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

export type SessionUpdate =
  | { type: "message"; role: "agent" | "user"; text: string; messageId?: string }
  | { type: "plan"; entries: Array<{ content: string; status: string; priority?: string }> }
  | { type: "tool"; id: string; title: string; kind: string; status: string }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; id: string; output: string; exitCode?: number | null }
  | { type: "usage"; used: number; size: number; cost?: { amount: number; currency: string } };

export interface RequestPermissionParams {
  sessionId: string;
  operation: string;
  details: Record<string, unknown>;
}

export interface RequestPermissionResult {
  outcome: "allow" | "deny";
  reason?: string;
}

export interface ReadTextFileParams {
  sessionId: string;
  path: string;
}

export interface ReadTextFileResult {
  content: string;
}

export interface WriteTextFileParams {
  sessionId: string;
  path: string;
  content: string;
}

export interface WriteTextFileResult {
  bytes: number;
}

export interface TerminalCreateParams {
  sessionId: string;
  command: string;
  cwd?: string;
}

export interface TerminalCreateResult {
  terminalId: string;
}

export interface TerminalOutputParams {
  sessionId: string;
  terminalId: string;
}

export interface TerminalOutputResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface TerminalWaitForExitParams {
  sessionId: string;
  terminalId: string;
  timeoutMs?: number;
}

export interface TerminalWaitForExitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TerminalKillParams {
  sessionId: string;
  terminalId: string;
}

export interface TerminalReleaseParams {
  sessionId: string;
  terminalId: string;
}

export type CodexMimoEvent =
  | { type: "message"; role: "agent" | "user"; text: string; messageId?: string }
  | { type: "plan"; entries: Array<{ content: string; status: string; priority?: string }> }
  | { type: "tool"; id: string; title: string; kind: string; status: string }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; id: string; output: string; exitCode?: number | null }
  | { type: "usage"; used: number; size: number; cost?: { amount: number; currency: string } };
