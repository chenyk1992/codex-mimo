export interface NormalizedMimoEvent {
  type: "message" | "tool" | "diff" | "usage" | "error" | "progress" | "raw";
  text?: string;
  toolName?: string;
  status?: string;
  path?: string;
  progressKind?: "step_start" | "step_finish";
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
  };
  raw: unknown;
}

export interface MimoCommandEvidence {
  command: string;
  cwd: string;
  exitCode: number;
  eventIndex: number;
  afterLastWrite: boolean;
  commandHash?: string;
  repositoryFingerprint?: string;
  timestamp?: string;
}

const WRITE_TOOL_NAMES = new Set(["write", "edit", "apply_patch"]);

interface EventSummary {
  messages: number;
  tools: number;
  diffs: number;
  errors: number;
  progress: number;
  raw: number;
  lastEvent?: string;
  lastTool?: string;
}

export function parseMimoJsonLines(stdout: string): NormalizedMimoEvent[] {
  const events: NormalizedMimoEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(normalizeMimoEvent(JSON.parse(trimmed)));
    } catch {
      events.push({ type: "raw", text: trimmed, raw: trimmed });
    }
  }
  return events;
}

export function normalizeMimoEvent(raw: unknown): NormalizedMimoEvent {
  if (!isRecord(raw)) return { type: "raw", raw };

  const type = String(raw.type ?? raw.event ?? "");
  if (type === "message" || type === "assistant" || type === "text") {
    return {
      type: "message",
      text: stringValue(raw.text ?? raw.content ?? raw.message) ?? nestedRawMessageText(raw),
      raw
    };
  }

  if (type === "tool" || type === "tool_call") {
    return {
      type: "tool",
      toolName: stringValue(raw.tool ?? raw.name ?? raw.toolName),
      status: stringValue(raw.status),
      raw
    };
  }

  if (type === "diff") {
    return { type: "diff", path: stringValue(raw.path), raw };
  }

  if (type === "usage") {
    return {
      type: "usage",
      usage: {
        inputTokens: numberValue(raw.inputTokens ?? raw.input_tokens),
        outputTokens: numberValue(raw.outputTokens ?? raw.output_tokens),
        cost: numberValue(raw.cost)
      },
      raw
    };
  }

  if (type === "error") {
    return { type: "error", text: errorText(raw), raw };
  }

  if (type === "tool_use") {
    const part = raw.part;
    if (isRecord(part) && stringValue(part.type) === "tool") {
      const state = isRecord(part.state) ? part.state : undefined;
      return {
        type: "tool",
        toolName: stringValue(part.tool ?? part.name ?? part.toolName),
        status: stringValue(state?.status ?? part.status),
        text: nestedToolCommandText(part),
        raw
      };
    }
  }

  if (type === "step_start" || type === "step_finish") {
    return {
      type: "progress",
      progressKind: type === "step_start" ? "step_start" : "step_finish",
      text: type === "step_start" ? "MiMoCode step started." : "MiMoCode step finished.",
      raw
    };
  }

  return { type: "raw", raw };
}

export function summarizeEvents(events: NormalizedMimoEvent[]): EventSummary {
  const last = [...events].reverse().find((event) => event.type !== "usage");
  const lastTool = [...events].reverse().find((event) => event.type === "tool" && event.toolName);

  return {
    messages: events.filter((event) => event.type === "message").length,
    tools: events.filter((event) => event.type === "tool").length,
    diffs: events.filter((event) => event.type === "diff").length,
    errors: events.filter((event) => event.type === "error").length,
    progress: events.filter((event) => event.type === "progress").length,
    raw: events.filter((event) => event.type === "raw").length,
    lastEvent: last ? describeEvent(last) : undefined,
    lastTool: lastTool?.toolName
  };
}

export function extractSessionIdFromRawLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return extractSessionId(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function extractToolNameFromRawLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const normalized = normalizeMimoEvent(JSON.parse(trimmed));
    return normalized.type === "tool" ? normalized.toolName : undefined;
  } catch {
    return undefined;
  }
}

export function extractSessionIdFromEvents(events: NormalizedMimoEvent[]): string | null {
  for (const event of events) {
    const sessionId = extractSessionId(event.raw);
    if (sessionId) return sessionId;
  }
  return null;
}

export function extractFinalText(events: NormalizedMimoEvent[]): string {
  return [...events]
    .reverse()
    .find((event) => event.type === "message" && event.text?.trim())
    ?.text?.trim() ?? "";
}

export function extractToolUseWritePaths(events: NormalizedMimoEvent[]): string[] {
  const paths = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool" || !WRITE_TOOL_NAMES.has(event.toolName?.toLowerCase() ?? "")) {
      continue;
    }
    const input = toolInput(event.raw);
    const filePath = input
      ? stringValue(input.file_path ?? input.filepath ?? input.filePath ?? input.path)
      : undefined;
    if (filePath?.trim()) {
      paths.add(filePath.trim().replace(/\\/g, "/").replace(/^\.\//, ""));
    }
  }
  return [...paths].sort();
}

export function extractPassingCommandEvidence(
  events: NormalizedMimoEvent[],
  defaultCwd: string
): MimoCommandEvidence[] {
  const lastWriteIndex = events.reduce(
    (latest, event, index) =>
      event.type === "tool" && WRITE_TOOL_NAMES.has(event.toolName?.toLowerCase() ?? "")
        ? index
        : latest,
    -1
  );
  const evidence: MimoCommandEvidence[] = [];

  for (const [eventIndex, event] of events.entries()) {
    if (event.type !== "tool" || event.toolName?.toLowerCase() !== "bash") continue;
    const raw = isRecord(event.raw) ? event.raw : undefined;
    const part = raw && isRecord(raw.part) ? raw.part : undefined;
    const state = part && isRecord(part.state) ? part.state : undefined;
    const input = state && isRecord(state.input) ? state.input : undefined;
    const metadata = state && isRecord(state.metadata) ? state.metadata : undefined;
    const command = input ? stringValue(input.command) : undefined;
    const exitCode = metadata ? integerValue(metadata.exit ?? metadata.exitCode) : undefined;
    if (!command?.trim() || exitCode !== 0) continue;
    const cwd = input
      ? stringValue(input.cwd ?? input.workdir ?? input.working_directory) ?? defaultCwd
      : defaultCwd;
    const timestamp = raw
      ? stringValue(raw.timestamp ?? raw.createdAt ?? raw.created_at)
      : undefined;
    evidence.push({
      command: command.trim(),
      cwd,
      exitCode,
      eventIndex,
      afterLastWrite: eventIndex > lastWriteIndex,
      ...(timestamp ? { timestamp } : {})
    });
  }
  return evidence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}

function toolInput(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const part = isRecord(raw.part) ? raw.part : undefined;
  const state = part && isRecord(part.state) ? part.state : undefined;
  return state && isRecord(state.input) ? state.input : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nestedRawMessageText(raw: Record<string, unknown>): string | undefined {
  const part = raw.part;
  if (isRecord(part)) {
    const text = stringValue(part.text ?? part.content ?? part.message);
    if (text) return text;
  }

  const rawPayload = raw.raw;
  if (!isRecord(rawPayload)) return undefined;

  const nestedPart = rawPayload.part;
  if (isRecord(nestedPart)) {
    return stringValue(nestedPart.text ?? nestedPart.content ?? nestedPart.message);
  }

  return stringValue(rawPayload.text ?? rawPayload.content ?? rawPayload.message);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function nestedToolCommandText(part: Record<string, unknown>): string | undefined {
  const state = part.state;
  if (!isRecord(state)) return undefined;
  const input = state.input;
  if (!isRecord(input)) return undefined;
  return stringValue(input.command ?? input.file_path ?? input.filepath ?? input.filePath ?? input.path);
}

function errorText(raw: Record<string, unknown>): string | undefined {
  const direct = stringValue(raw.error ?? raw.message);
  if (direct) return direct;
  const part = raw.part;
  return isRecord(part) ? stringValue(part.message ?? part.text) : undefined;
}

function describeEvent(event: NormalizedMimoEvent): string {
  if (event.type === "tool") return `tool:${event.toolName ?? "unknown"}${event.status ? `:${event.status}` : ""}`;
  if (event.type === "progress") return event.progressKind ?? "progress";
  if (event.type === "message") return "message";
  if (event.type === "error") return "error";
  if (event.type === "diff") return `diff:${event.path ?? "unknown"}`;
  if (event.type === "usage") return "usage";
  return "raw";
}

function extractSessionId(value: unknown): string | null {
  if (!isRecord(value)) return null;

  const direct = stringValue(value.sessionID ?? value.sessionId);
  if (direct) return direct;

  const part = value.part;
  if (isRecord(part)) {
    const partId = stringValue(part.sessionID ?? part.sessionId);
    if (partId) return partId;
  }

  const raw = value.raw;
  if (isRecord(raw)) return extractSessionId(raw);

  return null;
}
