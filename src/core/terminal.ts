import { spawn, type ChildProcess } from "node:child_process";

export interface ManagedTerminal {
  id: string;
  process: ChildProcess;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export class TerminalManager {
  private terminals = new Map<string, ManagedTerminal>();
  private nextId = 1;

  create(command: string, cwd: string): ManagedTerminal {
    const id = `term_${this.nextId++}`;
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "sh";
    const shellArgs = isWindows ? ["/c", command] : ["-c", command];

    const child = spawn(shell, shellArgs, { cwd, stdio: ["pipe", "pipe", "pipe"] });

    const terminal: ManagedTerminal = {
      id,
      process: child,
      stdout: "",
      stderr: "",
      exitCode: null
    };

    child.stdout?.on("data", (data: Buffer) => {
      terminal.stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      terminal.stderr += data.toString();
    });
    child.on("exit", (code) => {
      terminal.exitCode = code;
    });

    this.terminals.set(id, terminal);
    return terminal;
  }

  get(id: string): ManagedTerminal | undefined {
    return this.terminals.get(id);
  }

  kill(id: string): void {
    const terminal = this.terminals.get(id);
    if (terminal && terminal.exitCode === null) {
      terminal.process.kill("SIGTERM");
    }
  }

  release(id: string): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      if (terminal.exitCode === null) {
        terminal.process.kill("SIGTERM");
      }
      this.terminals.delete(id);
    }
  }

  async waitForExit(id: string, timeoutMs: number = 30000): Promise<ManagedTerminal> {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error(`Terminal ${id} not found`);
    if (terminal.exitCode !== null) return terminal;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Terminal ${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      terminal.process.on("exit", () => {
        clearTimeout(timer);
        resolve(terminal);
      });
    });
  }
}
