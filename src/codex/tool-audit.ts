import fs from "node:fs";

export interface McpToolAuditRecord {
  timestamp: string;
  pid: number;
  toolName: string;
}

export function appendMcpToolAudit(
  toolName: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  const file = env.CODEX_MIMO_TOOL_AUDIT_FILE?.trim();
  if (!file) return;

  const record: McpToolAuditRecord = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    toolName
  };
  try {
    // One short O_APPEND write keeps concurrent process records separate. Audit is
    // best-effort observability and must never replace a tool call's outcome.
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
  } catch {}
}
