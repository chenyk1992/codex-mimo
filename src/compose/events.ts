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
      const toolName = stringValue(part.tool ?? part.name ?? part.toolName);
      return {
        type: "tool",
        toolName,
        status: stringValue(state?.status ?? part.status),
        text: nestedToolCommandText(part),
        path: nestedToolFilePath(part, toolName),
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

export function extractFinalText(events: NormalizedMimoEvent[]): string {
  return [...events]
    .reverse()
    .find((event) => event.type === "message" && event.text?.trim())
    ?.text?.trim() ?? "";
}

/** Paths from write/edit/apply_patch tool_use events (and explicit diff events). */
export function collectChangedFilesFromEvents(events: readonly NormalizedMimoEvent[]): string[] {
  const files: string[] = [];
  for (const event of events) {
    if (event.type === "diff" && event.path?.trim()) {
      files.push(event.path.trim());
      continue;
    }
    if (event.type !== "tool") continue;
    const tool = event.toolName?.toLowerCase();
    if (tool !== "write" && tool !== "edit" && tool !== "apply_patch") continue;
    const filePath = event.path?.trim();
    if (filePath) files.push(filePath);
  }
  return [...new Set(files)];
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
  return stringValue(input.command ?? input.file_path ?? input.filepath ?? input.filePath ?? input.path);
}

function nestedToolFilePath(
  part: Record<string, unknown>,
  toolName: string | undefined
): string | undefined {
  const tool = toolName?.toLowerCase();
  if (tool !== "write" && tool !== "edit" && tool !== "apply_patch" && tool !== "read") {
    return undefined;
  }
  const state = part.state;
  if (!isRecord(state)) return undefined;
  const input = state.input;
  if (!isRecord(input)) return undefined;
  return stringValue(input.file_path ?? input.filepath ?? input.filePath ?? input.path);
}

function errorText(raw: Record<string, unknown>): string | undefined {
  const direct = stringValue(raw.error ?? raw.message);
  if (direct) return direct;
  const part = raw.part;
  return isRecord(part) ? stringValue(part.message ?? part.text) : undefined;
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
