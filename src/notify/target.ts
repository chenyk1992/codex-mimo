import type { NotificationInput, NotificationTarget } from "./types.js";
import { InputValidationError } from "../core/input-validation.js";

export function resolveNotificationTarget(
  input: NotificationInput | undefined,
  _env: NodeJS.ProcessEnv
): NotificationTarget | undefined {
  if (!input) return undefined;

  if (input.type === "codex") {
    const threadId = input.threadId?.trim() ?? "";
    if (!threadId) {
      throw new InputValidationError("Codex notification requires explicit threadId");
    }
    return { type: "codex", threadId };
  }

  const url = input.url.trim();
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new InputValidationError("Webhook URL must use http or https");
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new InputValidationError("Webhook URL must use http or https");
  }

  const secretEnv = input.secretEnv.trim();
  if (!secretEnv) {
    throw new InputValidationError("Webhook notification requires secretEnv");
  }
  return { type: "webhook", url, secretEnv };
}
