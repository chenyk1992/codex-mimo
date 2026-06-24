import { z } from "zod";
import { COMPOSE_WORKFLOW_NAMES } from "../compose/workflow-names.js";

export const PlanInput = z.object({
  cwd: z.string(),
  task: z.string(),
  agent: z.string().default("plan"),
  model: z.string().optional(),
  timeoutMs: z.number().int().positive().default(1_800_000)
}).strict();

export const ImplementInput = z.object({
  cwd: z.string(),
  task: z.string(),
  allowWrite: z.boolean().default(false),
  allowInstall: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(1_800_000)
}).strict();

export const ReviewInput = z.object({
  cwd: z.string(),
  base: z.string().default("HEAD"),
  timeoutMs: z.number().int().positive().default(1_800_000)
}).strict();

export const FixCiInput = z.object({
  cwd: z.string(),
  file: z.string(),
  task: z.string().optional(),
  timeoutMs: z.number().int().positive().default(1_800_000)
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

export const ComposeInput = z.object({
  cwd: z.string(),
  workflow: ComposeWorkflowSchema,
  task: z.string().optional(),
  file: z.string().optional(),
  since: z.string().optional(),
  model: z.string().optional(),
  attach: z.string().optional(),
  session: z.string().optional(),
  fork: z.boolean().default(false),
  continue: z.boolean().default(false),
  verification: z.array(z.string()).optional(),
  dryRun: z.boolean().default(false),
  reportDir: z.string().optional(),
  timeoutMs: z.number().int().positive().default(1_800_000),
  background: z.boolean().default(false),
  wait: z.boolean().default(false)
});

export const JobStatusInput = z.object({
  cwd: z.string(),
  jobId: z.string().optional()
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
