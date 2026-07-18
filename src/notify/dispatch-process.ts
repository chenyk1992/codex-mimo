import { spawnNotificationWorker } from "../core/job-process.js";

export interface NotificationDispatchStartOptions {
  spawnNotificationWorker?: typeof spawnNotificationWorker;
  onError?: (error: unknown) => void;
}

export function startNotificationDispatch(
  cwd: string,
  options: NotificationDispatchStartOptions = {}
): void {
  try {
    (options.spawnNotificationWorker ?? spawnNotificationWorker)(cwd);
  } catch (error) {
    options.onError?.(error);
  }
}
