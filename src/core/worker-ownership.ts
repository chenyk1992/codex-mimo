import path from "node:path";
import { resolveJobDir, resolveJobPaths } from "./job-store.js";

export function resolveJobWorkerOwnershipKey(cwd: string, jobId: string): string {
  return `${resolveJobPaths(cwd, jobId).jobFile}.worker-ownership`;
}

export function resolveNotificationWorkerOwnershipKey(cwd: string): string {
  return path.join(resolveJobDir(cwd), "notification-worker-ownership");
}
