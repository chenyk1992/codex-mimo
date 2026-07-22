export type NotificationInput =
  | { type: "codex"; threadId: string }
  | { type: "webhook"; url: string; secretEnv: string };

export type NotificationTarget =
  | { type: "codex"; threadId: string }
  | { type: "webhook"; url: string; secretEnv: string };

export type DeliveryStatus = "pending" | "delivering" | "delivered" | "failed";

export const NOTIFICATION_ERROR_CODES = [
  "codex_cli_not_found",
  "codex_cli_not_executable",
  "codex_app_server_unavailable",
  "codex_app_server_incompatible",
  "codex_thread_busy",
  "codex_thread_missing",
  "codex_thread_forbidden",
  "codex_turn_interrupted",
  "codex_turn_failed",
  "codex_turn_timeout"
] as const;

export type NotificationErrorCode = typeof NOTIFICATION_ERROR_CODES[number];

export function isNotificationErrorCode(value: unknown): value is NotificationErrorCode {
  return typeof value === "string" &&
    (NOTIFICATION_ERROR_CODES as readonly string[]).includes(value);
}

export interface NotificationDelivery {
  id: string;
  eventId: string;
  jobId: string;
  signalCursor: number;
  target: NotificationTarget;
  status: DeliveryStatus;
  attempts: number;
  createdAt: string;
  nextAttemptAt?: string;
  leaseUntil?: string;
  deliveredAt?: string;
  lastError?: string;
  lastErrorCode?: NotificationErrorCode;
}

export interface EnqueueDeliveryInput {
  jobId: string;
  signalCursor: number;
  target: NotificationTarget;
  createdAt: string;
}

export type DeliveryAttemptResult =
  | { outcome: "delivered" }
  | { outcome: "retry"; error: string; errorCode?: NotificationErrorCode }
  | { outcome: "permanent"; error: string; errorCode?: NotificationErrorCode };

export class StaleDeliveryGenerationError extends Error {
  readonly code = "STALE_DELIVERY_GENERATION" as const;

  constructor(message: string) {
    super(message);
    this.name = "StaleDeliveryGenerationError";
  }
}
