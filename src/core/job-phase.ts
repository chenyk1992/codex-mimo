import type { NormalizedMimoEvent } from "../compose/events.js";
import type { JobPhase } from "./jobs.js";

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch"]);
const VERIFY_COMMAND_PATTERN =
  /\b(?:tests?|lint|build|type-?check|check|verify|validate|pytest|jest|vitest|tsc|eslint)\b|(?:npm|pnpm|yarn)\s+test/i;

export function inferPhaseFromEvent(event: NormalizedMimoEvent): JobPhase | null {
  if (event.type === "error") return "failed";
  if (event.type === "diff") return "editing";
  if (event.type === "message") return "investigating";
  if (event.type === "progress") return "investigating";
  if (event.type !== "tool") return null;

  const toolName = event.toolName?.toLowerCase();
  if (!toolName) return "investigating";

  if (EDIT_TOOLS.has(toolName)) return "editing";
  if (toolName === "bash") {
    return event.text && VERIFY_COMMAND_PATTERN.test(event.text) ? "verifying" : "investigating";
  }

  return "investigating";
}

export function summarizeEventForLog(event: NormalizedMimoEvent): string | null {
  const text = event.text?.trim();
  if (text) return text;

  if (event.type === "tool" && event.toolName) {
    return `Tool ${event.toolName}${event.status ? ` ${event.status}` : ""}.`;
  }

  if (event.type === "diff" && event.path) return `Changed ${event.path}.`;
  if (event.type === "usage" && event.usage) return "Usage updated.";
  if (event.type === "error") return "MiMoCode reported an error.";

  return null;
}
