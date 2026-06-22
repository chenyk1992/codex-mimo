import { z } from "zod";
import { COMPOSE_WORKFLOW_NAMES } from "../compose/workflow-names.js";

export const PlanInput = z.object({
  cwd: z.string(),
  task: z.string(),
  agent: z.string().default("plan"),
  model: z.string().optional()
});

export const ImplementInput = z.object({
  cwd: z.string(),
  task: z.string(),
  allowWrite: z.boolean().default(false),
  allowInstall: z.boolean().default(false)
});

export const ReviewInput = z.object({
  cwd: z.string(),
  base: z.string().default("HEAD")
});

export const FixCiInput = z.object({
  cwd: z.string(),
  file: z.string(),
  task: z.string().optional()
});

export const ResumeInput = z.object({
  cwd: z.string(),
  session: z.string(),
  task: z.string()
});

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
  timeoutMs: z.number().int().positive().optional()
});
