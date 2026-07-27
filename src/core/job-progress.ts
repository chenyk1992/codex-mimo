import type { EffectiveProgressKind } from "./jobs.js";
import { redactDiagnosticText } from "./job-output.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export interface ProgressEventInput {
  type: string;
  tool?: string;
  command?: string;
  filePath?: string;
  phase?: string;
  exitCode?: number | null;
  text?: string;
}

export interface ClassifyEffectiveProgressInput {
  previousFingerprint?: string;
  event: ProgressEventInput;
}

export interface ClassifyEffectiveProgressResult {
  progressed: boolean;
  kind?: EffectiveProgressKind;
  fingerprint?: string;
  lastCommand?: string;
}

export function classifyEffectiveProgress(
  input: ClassifyEffectiveProgressInput
): ClassifyEffectiveProgressResult {
  const event = input.event;
  const type = event.type.toLowerCase();

  if (type === "reasoning" || type === "text" || type === "message") {
    return { progressed: false };
  }

  if (type === "phase" && event.phase) {
    const fingerprint = `phase:${event.phase}`;
    if (fingerprint === input.previousFingerprint) return { progressed: false };
    return { progressed: true, kind: "phase_change", fingerprint };
  }

  if (type === "tool_use" || type === "tool") {
    const tool = (event.tool ?? "tool").toLowerCase();
    const safeCommand = event.command
      ? redactDiagnosticText(event.command).slice(0, 240)
      : undefined;
    const safePath = event.filePath?.replace(/\\/g, "/");
    const phase = event.phase ?? "unknown";
    const exit = event.exitCode === undefined ? "" : String(event.exitCode);
    const identity = safePath ?? safeCommand ?? tool;
    const fingerprint = `tool:${tool}:${phase}:${identity}:${exit}`;
    if (fingerprint === input.previousFingerprint) return { progressed: false };

    const kind: EffectiveProgressKind =
      tool === "write" || tool === "edit" || tool === "apply_patch"
        ? "file_change"
        : phase === "finished" || phase === "completed"
          ? "tool_finish"
          : "tool_start";

    return {
      progressed: true,
      kind,
      fingerprint,
      ...(safeCommand ? { lastCommand: safeCommand } : {})
    };
  }

  if (type === "step_start" || type === "step_finish") {
    const fingerprint = `${type}:${event.phase ?? event.text ?? ""}`;
    if (fingerprint === input.previousFingerprint) return { progressed: false };
    return { progressed: true, kind: "phase_change", fingerprint };
  }

  return { progressed: false };
}

export function progressIdleMs(lastProgressAt: string | undefined, nowMs: number): number | null {
  if (!lastProgressAt) return null;
  const then = Date.parse(lastProgressAt);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, nowMs - then);
}

export function parseProgressEventInput(line: string): ProgressEventInput | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return progressEventInputFromRaw(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function progressEventInputFromRaw(raw: unknown): ProgressEventInput | undefined {
  if (!isRecord(raw)) return undefined;
  const type = String(raw.type ?? raw.event ?? "");
  if (!type) return undefined;

  if (type === "tool_use" || type === "tool" || type === "tool_call") {
    const part = raw.part;
    if (isRecord(part) && stringValue(part.type) === "tool") {
      const state = isRecord(part.state) ? part.state : undefined;
      const input = isRecord(state?.input) ? state.input : undefined;
      const metadata = isRecord(state?.metadata) ? state.metadata : undefined;
      const filePath = stringValue(
        input?.file_path ?? input?.filepath ?? input?.filePath ?? input?.path
      );
      return {
        type,
        tool: stringValue(part.tool ?? part.name ?? part.toolName),
        command: stringValue(input?.command),
        filePath,
        phase: stringValue(state?.status ?? part.status ?? state?.phase),
        exitCode: numberValue(metadata?.exit ?? state?.exitCode)
      };
    }
    return {
      type,
      tool: stringValue(raw.tool ?? raw.name ?? raw.toolName),
      phase: stringValue(raw.status ?? raw.phase)
    };
  }

  if (type === "phase") {
    return { type, phase: stringValue(raw.phase) };
  }

  if (type === "step_start" || type === "step_finish") {
    return {
      type,
      phase: stringValue(raw.phase),
      text: stringValue(raw.text ?? raw.message)
    };
  }

  if (type === "reasoning" || type === "text" || type === "message") {
    return { type, text: stringValue(raw.text ?? raw.content ?? raw.message) };
  }

  return { type };
}

export function classifyStallReason(input: {
  lastProgressKind?: EffectiveProgressKind;
  lastTool?: string;
  processAlive: boolean;
  hasRecentActivity: boolean;
}): string {
  if (!input.processAlive) return "worker_lost";
  if (input.lastProgressKind === "tool_start" || input.lastTool === "bash") {
    return "command_silent";
  }
  if (input.hasRecentActivity) return "no_effective_progress";
  return "agent_silent";
}
