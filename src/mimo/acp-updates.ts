import type { CodexMimoEvent, SessionUpdateParams, SessionUpdate } from "./acp-types.js";

export function convertUpdate(params: SessionUpdateParams): CodexMimoEvent {
  const update = params.update;
  switch (update.type) {
    case "message":
      return {
        type: "message",
        role: update.role,
        text: update.text,
        messageId: update.messageId
      };
    case "plan":
      return {
        type: "plan",
        entries: update.entries
      };
    case "tool":
      return {
        type: "tool",
        id: update.id,
        title: update.title,
        kind: update.kind,
        status: update.status
      };
    case "diff":
      return {
        type: "diff",
        path: update.path,
        oldText: update.oldText,
        newText: update.newText
      };
    case "terminal":
      return {
        type: "terminal",
        id: update.id,
        output: update.output,
        exitCode: update.exitCode
      };
    case "usage":
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
