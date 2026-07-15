export type NotificationInput =
  | { type: "codex"; threadId?: string }
  | { type: "webhook"; url: string; secretEnv: string };

export type NotificationTarget =
  | { type: "codex"; threadId: string }
  | { type: "webhook"; url: string; secretEnv: string };
