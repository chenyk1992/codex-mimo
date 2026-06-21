import { z } from "zod";

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
