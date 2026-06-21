import fs from "node:fs";
import { AcpClient, type AgentRequestHandler, type UpdateHandler } from "./acp-client.js";
import { startMimoAcp, type AcpProcess } from "./acp-process.js";
import { convertUpdate } from "./acp-updates.js";
import type {
  CodexMimoEvent,
  InitializeResult,
  SessionNewResult,
  SessionPromptResult,
  ReadTextFileParams,
  WriteTextFileParams,
  TerminalCreateParams,
  TerminalOutputParams,
  TerminalWaitForExitParams,
  TerminalKillParams,
  TerminalReleaseParams,
  RequestPermissionParams
} from "./acp-types.js";
import {
  type BridgePolicy,
  decideFileRead,
  decideFileWrite,
  decideCommand
} from "../core/policy.js";
import { normalizePath } from "../core/paths.js";
import { AuditLogger } from "../core/audit.js";
import { TerminalManager } from "../core/terminal.js";

export interface AcpBridgeOptions {
  cwd: string;
  policy: BridgePolicy;
  logDir?: string;
}

export interface AcpBridgeResult {
  events: CodexMimoEvent[];
  sessionId: string | null;
  changedFiles: string[];
  stopReason: string;
}

export class AcpBridge {
  private acp: AcpProcess | null = null;
  private client: AcpClient | null = null;
  private audit: AuditLogger;
  private terminals = new TerminalManager();
  private events: CodexMimoEvent[] = [];
  private sessionId: string | null = null;
  private policy: BridgePolicy;
  private cwd: string;

  constructor(options: AcpBridgeOptions) {
    this.cwd = options.cwd;
    this.policy = options.policy;
    this.audit = new AuditLogger(options.logDir ?? `${options.cwd}/.codex-mimo`);
  }

  async run(task: string): Promise<AcpBridgeResult> {
    this.audit.log({ type: "session_start", workflow: "acp", cwd: this.cwd });

    try {
      this.acp = startMimoAcp(this.cwd);

      this.client = new AcpClient(
        (data) => this.acp!.write(data),
        this.handleAgentRequest.bind(this),
        this.handleUpdate.bind(this)
      );

      this.acp.process.stdout?.on("data", (chunk: Buffer) => {
        this.client!.onData(chunk.toString());
      });

      this.acp.process.stderr?.on("data", (_chunk: Buffer) => {
      });

      const initResult = (await this.client.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true
        },
        clientInfo: {
          name: "codex-mimo",
          title: "Codex MiMoCode Bridge",
          version: "0.1.0"
        }
      })) as InitializeResult;

      const sessionResult = (await this.client.sessionNew({
        cwd: this.cwd
      })) as SessionNewResult;

      this.sessionId = sessionResult.sessionId;

      const promptResult = (await this.client.sessionPrompt({
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: task }]
      })) as SessionPromptResult;

      const changedFiles = this.extractChangedFiles();

      this.audit.log({
        type: "session_end",
        stopReason: promptResult.stopReason,
        changedFiles
      });

      return {
        events: this.events,
        sessionId: this.sessionId,
        changedFiles,
        stopReason: promptResult.stopReason
      };
    } finally {
      this.cleanup();
    }
  }

  private handleUpdate(params: import("./acp-types.js").SessionUpdateParams): void {
    const event = convertUpdate(params);
    this.events.push(event);
  }

  private async handleAgentRequest(
    method: string,
    params: unknown
  ): Promise<unknown> {
    switch (method) {
      case "session/request_permission":
        return this.handlePermissionRequest(
          params as RequestPermissionParams
        );
      case "fs/read_text_file":
        return this.handleFileRead(params as ReadTextFileParams);
      case "fs/write_text_file":
        return this.handleFileWrite(params as WriteTextFileParams);
      case "terminal/create":
        return this.handleTerminalCreate(params as TerminalCreateParams);
      case "terminal/output":
        return this.handleTerminalOutput(params as TerminalOutputParams);
      case "terminal/wait_for_exit":
        return this.handleTerminalWait(params as TerminalWaitForExitParams);
      case "terminal/kill":
        return this.handleTerminalKill(params as TerminalKillParams);
      case "terminal/release":
        return this.handleTerminalRelease(params as TerminalReleaseParams);
      default:
        throw new Error(`Unknown ACP method: ${method}`);
    }
  }

  private handlePermissionRequest(
    params: RequestPermissionParams
  ): { outcome: "allow" | "deny"; reason?: string } {
    const { operation, details } = params;
    let decision: "allow" | "deny" = "deny";

    if (operation === "terminal") {
      const command = (details.command as string) ?? "";
      const cmdDecision = decideCommand(this.policy, command);
      decision = cmdDecision === "deny" ? "deny" : "allow";
      this.audit.log({
        type: "permission",
        operation: "terminal",
        command,
        outcome: decision
      });
    } else if (operation === "file_write") {
      const filePath = (details.path as string) ?? "";
      const fileDecision = decideFileWrite(this.policy, filePath);
      decision = fileDecision === "deny" ? "deny" : "allow";
      this.audit.log({
        type: "permission",
        operation: "file_write",
        path: filePath,
        outcome: decision
      });
    } else {
      this.audit.log({
        type: "permission",
        operation,
        outcome: "deny"
      });
    }

    return {
      outcome: decision,
      reason: decision === "deny" ? "Denied by bridge policy" : undefined
    };
  }

  private handleFileRead(
    params: ReadTextFileParams
  ): { content: string } | { error: string } {
    const normalized = normalizePath(params.path);
    const decision = decideFileRead(this.policy, normalized);

    this.audit.log({
      type: "file_read",
      path: normalized,
      outcome: decision
    });

    if (decision === "deny") {
      return { error: `Read denied by policy: ${normalized}` };
    }

    try {
      const content = fs.readFileSync(normalized, "utf-8");
      return { content };
    } catch (err) {
      return {
        error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  private handleFileWrite(
    params: WriteTextFileParams
  ): { bytes: number } | { error: string } {
    const normalized = normalizePath(params.path);
    const decision = decideFileWrite(this.policy, normalized);

    this.audit.log({
      type: "file_write",
      path: normalized,
      outcome: decision,
      bytes: params.content.length
    });

    if (decision === "deny") {
      return { error: `Write denied by policy: ${normalized}` };
    }

    try {
      fs.writeFileSync(normalized, params.content, "utf-8");
      return { bytes: Buffer.byteLength(params.content, "utf-8") };
    } catch (err) {
      return {
        error: `Failed to write file: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  private handleTerminalCreate(
    params: TerminalCreateParams
  ): { terminalId: string } | { error: string } {
    const command = params.command;
    const decision = decideCommand(this.policy, command);

    this.audit.log({
      type: "terminal_create",
      command,
      outcome: decision
    });

    if (decision === "deny") {
      return { error: `Command denied by policy: ${command}` };
    }

    const cwd = params.cwd ? normalizePath(params.cwd) : this.cwd;
    const terminal = this.terminals.create(command, cwd);
    return { terminalId: terminal.id };
  }

  private handleTerminalOutput(
    params: TerminalOutputParams
  ): { stdout: string; stderr: string; exitCode: number | null } {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      return { stdout: "", stderr: "Terminal not found", exitCode: -1 };
    }
    return {
      stdout: terminal.stdout,
      stderr: terminal.stderr,
      exitCode: terminal.exitCode
    };
  }

  private async handleTerminalWait(
    params: TerminalWaitForExitParams
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const terminal = await this.terminals.waitForExit(
      params.terminalId,
      params.timeoutMs
    );
    return {
      exitCode: terminal.exitCode ?? -1,
      stdout: terminal.stdout,
      stderr: terminal.stderr
    };
  }

  private handleTerminalKill(params: TerminalKillParams): Record<string, never> {
    this.terminals.kill(params.terminalId);
    return {};
  }

  private handleTerminalRelease(params: TerminalReleaseParams): Record<string, never> {
    this.terminals.release(params.terminalId);
    return {};
  }

  private extractChangedFiles(): string[] {
    const files = new Set<string>();
    for (const event of this.events) {
      if (event.type === "diff") {
        files.add(event.path);
      }
    }
    return [...files];
  }

  private cleanup(): void {
    this.audit.close();
    this.acp?.stop();
  }
}
