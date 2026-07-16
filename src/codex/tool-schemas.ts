import { z } from "zod";
import { COMPOSE_WORKFLOW_NAMES } from "../compose/workflow.js";

const CodexNotifySchema = z.object({
  type: z.literal("codex"),
  threadId: z.string().min(1).optional()
}).strict();

const WebhookNotifySchema = z.object({
  type: z.literal("webhook"),
  url: z.string().min(1),
  secretEnv: z.string().min(1)
}).strict();

export const NotifySchema = z.discriminatedUnion("type", [CodexNotifySchema, WebhookNotifySchema]);

export const JobOptionsSchema = z.object({
  cwd: z.string().min(1),
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().default(1_800_000),
  notify: NotifySchema.optional()
}).strict();

export const PlanInput = JobOptionsSchema.extend({
  task: z.string().min(1)
}).strict();

export const ImplementInput = JobOptionsSchema.extend({
  task: z.string().min(1),
  allowWrite: z.boolean()
}).strict();

export const ReviewInput = JobOptionsSchema.extend({
  base: z.string().min(1).default("HEAD")
}).strict();

export const FixCiInput = JobOptionsSchema.extend({
  file: z.string().min(1),
  task: z.string().min(1).optional()
}).strict();

export const ResumeInput = z.object({
  cwd: z.string(),
  session: z.string(),
  task: z.string(),
  timeoutMs: z.number().int().positive().default(1_800_000)
}).strict();

export const HealthcheckInput = z.object({
  cwd: z.string().optional()
});

export const ComposeWorkflowSchema = z.enum(COMPOSE_WORKFLOW_NAMES);

export const ComposeInput = JobOptionsSchema.extend({
  workflow: ComposeWorkflowSchema,
  task: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  since: z.string().min(1).optional(),
  verification: z.array(z.string().min(1)).optional(),
  reportDir: z.string().min(1).optional()
}).strict();

export const JobStatusInput = z.object({
  cwd: z.string(),
  jobId: z.string().optional()
});

export const JobEventsInput = z.object({
  cwd: z.string(),
  jobId: z.string().optional(),
  sinceCursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(100).default(20),
  minLevel: z.enum(["debug", "info", "warn", "error"]).default("debug")
});

export const JobWaitInput = JobEventsInput.extend({
  timeoutMs: z.number().int().positive().default(1_800_000),
  pollMs: z.number().int().positive().max(60_000).default(1_000)
});

export const JobWakeInput = JobEventsInput.omit({ limit: true, minLevel: true }).extend({
  minLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  timeoutMs: z.number().int().positive().default(1_800_000)
});

export const JobResultInput = z.object({
  cwd: z.string(),
  jobId: z.string().optional()
});

export const JobCancelInput = z.object({
  cwd: z.string(),
  jobId: z.string()
});

export const JobListInput = z.object({
  cwd: z.string(),
  all: z.boolean().default(false)
});

export const ResumeJobInput = z.object({
  cwd: z.string(),
  jobId: z.string(),
  task: z.string().min(1),
  background: z.boolean().default(false)
});
