export interface NormalizedMimoEvent {
  type: "message" | "tool" | "diff" | "usage" | "error" | "raw";
  text?: string;
  toolName?: string;
  status?: string;
  path?: string;
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

  return { type: "raw", raw };
}

export function summarizeEvents(events: NormalizedMimoEvent[]): EventSummary {
  return {
    messages: events.filter((event) => event.type === "message").length,
    tools: events.filter((event) => event.type === "tool").length,
    diffs: events.filter((event) => event.type === "diff").length,
    errors: events.filter((event) => event.type === "error").length
  };
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
