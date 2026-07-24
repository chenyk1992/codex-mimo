import { z } from "zod";
import { DEFAULT_WAIT_TIMEOUT_MS } from "../core/job-timeouts.js";

export {
  ComposeInput,
  FixCiInput,
  ImplementInput,
  NotifySchema,
  PlanInput,
  parseComposeInput,
  ResumeInput,
  ReviewInput
} from "../core/job-schemas.js";

export const HealthcheckInput = z.object({
  cwd: z.string().optional()
}).strict();

export const JobStatusInput = z.object({
  cwd: z.string().min(1),
  jobId: z.string().optional()
}).strict();

export const JobEventsInput = z.object({
  cwd: z.string().min(1),
  jobId: z.string().optional(),
  sinceCursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(100).default(20),
  minLevel: z.enum(["debug", "info", "warn", "error"]).default("warn")
}).strict();

export const JobWaitInput = JobEventsInput.extend({
  timeoutMs: z.number().int().positive().default(DEFAULT_WAIT_TIMEOUT_MS),
  // Wait must see completed/cancelled attention signals (level "info" in job-transition).
  minLevel: z.enum(["debug", "info", "warn", "error"]).default("info")
}).strict();

export const JobResultInput = z.object({
  cwd: z.string().min(1),
  jobId: z.string().optional()
}).strict();

export const JobCancelInput = z.object({
  cwd: z.string().min(1),
  jobId: z.string().min(1)
}).strict();

export const JobListInput = z.object({
  cwd: z.string().min(1),
  all: z.boolean().default(false)
}).strict();
