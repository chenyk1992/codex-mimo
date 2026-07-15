import type { NotificationInput, NotificationTarget } from "./types.js";

export function resolveNotificationTarget(
  input: NotificationInput | undefined,
  env: NodeJS.ProcessEnv
): NotificationTarget | undefined {
  if (!input) {
    const threadId = env.CODEX_THREAD_ID?.trim();
    return threadId ? { type: "codex", threadId } : undefined;
  }

  if (input.type === "codex") {
    const threadId = input.threadId?.trim();
    if (!threadId) {
      throw new Error("Codex notification requires threadId");
    }
    return { type: "codex", threadId };
  }

  const url = input.url.trim();
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error("Webhook URL must use http or https");
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("Webhook URL must use http or https");
  }

  const secretEnv = input.secretEnv.trim();
  if (!secretEnv) {
    throw new Error("Webhook notification requires secretEnv");
  }
  return { type: "webhook", url, secretEnv };
}
