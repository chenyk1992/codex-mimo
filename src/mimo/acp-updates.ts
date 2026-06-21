import type { CodexMimoEvent, SessionUpdateParams } from "./acp-types.js";

export function convertUpdate(params: SessionUpdateParams): CodexMimoEvent {
  const update = params.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return {
        type: "message",
        role: "agent",
        text: update.content.text,
        messageId: update.messageId
      };
    case "plan":
      return {
        type: "plan",
        entries: update.entries
      };
    case "tool_call":
      return {
        type: "tool",
        id: update.toolCallId,
        title: update.title,
        kind: update.kind,
        status: update.status
      };
    case "tool_call_update":
      return {
        type: "tool",
        id: update.toolCallId,
        title: update.title ?? "",
        kind: "",
        status: update.status ?? "running"
      };
    case "usage_update":
      return {
        type: "usage",
        used: update.used,
        size: update.size,
        cost: update.cost
      };
    default:
      return { type: "message", role: "agent", text: JSON.stringify(update) };
  }
}
