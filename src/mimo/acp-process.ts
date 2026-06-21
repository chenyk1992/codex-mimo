import { execa, type Subprocess } from "execa";

export interface AcpProcess {
  process: Subprocess;
  write(message: string): void;
  stop(): void;
}

export function startMimoAcp(cwd: string): AcpProcess {
  const child = execa("mimo", ["acp", "--cwd", cwd], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  });

  return {
    process: child,
    write(message: string) {
      child.stdin?.write(message);
    },
    stop() {
      child.kill("SIGTERM");
    }
  };
}
