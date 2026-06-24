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
    return { type: "error", text: stringValue(raw.error ?? raw.message), raw };
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

export function extractSessionIdFromEvents(events: NormalizedMimoEvent[]): string | null {
  for (const event of events) {
    const sessionId = extractSessionId(event.raw);
    if (sessionId) return sessionId;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  return stringValue(input.command ?? input.filePath ?? input.path);
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
