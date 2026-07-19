export type NotificationInput =
  | { type: "codex"; threadId?: string }
  | { type: "webhook"; url: string; secretEnv: string };

export type NotificationTarget =
  | { type: "codex"; threadId: string }
  | { type: "webhook"; url: string; secretEnv: string };

export type DeliveryStatus = "pending" | "delivering" | "delivered" | "failed";

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
}

export interface EnqueueDeliveryInput {
  jobId: string;
  signalCursor: number;
  target: NotificationTarget;
  createdAt: string;
}

export type DeliveryAttemptResult =
  | { outcome: "delivered" }
  | { outcome: "retry"; error: string }
  | { outcome: "permanent"; error: string };

export class StaleDeliveryGenerationError extends Error {
  readonly code = "STALE_DELIVERY_GENERATION" as const;

  constructor(message: string) {
    super(message);
    this.name = "StaleDeliveryGenerationError";
  }
}
