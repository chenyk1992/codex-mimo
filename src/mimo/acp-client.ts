import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  InitializeParams,
  InitializeResult,
  SessionNewParams,
  SessionNewResult,
  SessionPromptParams,
  SessionPromptResult,
  SessionUpdateParams
} from "./acp-types.js";

export class JsonRpcLineParser {
  private buffer = "";

  push(chunk: string): JsonRpcMessage[] {
    this.buffer += chunk;
    const messages: JsonRpcMessage[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      messages.push(JSON.parse(line) as JsonRpcMessage);
    }
    return messages;
  }
}

export function encodeMessage(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

export type AgentRequestHandler = (
  method: string,
  params: unknown
) => Promise<unknown>;

export type UpdateHandler = (params: SessionUpdateParams) => void;

export class AcpClient {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private parser = new JsonRpcLineParser();
  private writeFn: (data: string) => void;
  private onAgentRequest: AgentRequestHandler;
  private onUpdate: UpdateHandler;

  constructor(
    writeFn: (data: string) => void,
    onAgentRequest: AgentRequestHandler,
    onUpdate: UpdateHandler
  ) {
    this.writeFn = writeFn;
    this.onAgentRequest = onAgentRequest;
    this.onUpdate = onUpdate;
  }

  onData(chunk: string): void {
    const messages = this.parser.push(chunk);
    for (const msg of messages) {
      if ("method" in msg && !("id" in msg)) {
        this.handleNotification(msg as JsonRpcNotification);
      } else if ("id" in msg && "method" in msg) {
        this.handleAgentRequest(msg as JsonRpcRequest);
      } else if ("id" in msg) {
        this.handleResponse(msg as JsonRpcResponse);
      }
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(
        new Error(`ACP error ${response.error.code}: ${response.error.message}`)
      );
    } else {
      pending.resolve(response.result);
    }
  }

  private async handleAgentRequest(request: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.onAgentRequest(request.method, request.params);
      this.send({
        jsonrpc: "2.0",
        id: request.id,
        result
      });
    } catch (err) {
      this.send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : "Unknown error"
        }
      });
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === "session/update") {
      this.onUpdate(notification.params as SessionUpdateParams);
    }
  }

  private send(message: JsonRpcMessage): void {
    this.writeFn(encodeMessage(message));
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async initialize(params: InitializeParams): Promise<InitializeResult> {
    return (await this.request("initialize", params)) as InitializeResult;
  }

  async sessionNew(params: SessionNewParams): Promise<SessionNewResult> {
    return (await this.request("session/new", params)) as SessionNewResult;
  }

  async sessionPrompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    return (await this.request("session/prompt", params)) as SessionPromptResult;
  }
}
