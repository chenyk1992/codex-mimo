import { z } from "zod";
import {
  COMPOSE_WORKFLOW_NAMES,
  normalizeComposeBatchMode,
  validateComposeWorkflowInput
} from "../compose/workflow.js";

const CodexNotifySchema = z.object({
  type: z.literal("codex"),
  threadId: z.string().trim().min(1).describe("Originating Codex task ID")
}).strict();

const WebhookNotifySchema = z.object({
  type: z.literal("webhook"),
  url: z.string().min(1),
  secretEnv: z.string().min(1)
}).strict();

export const NotifySchema = z.discriminatedUnion("type", [CodexNotifySchema, WebhookNotifySchema]);

export const BatchModeSchema = z.enum(["auto", "single", "sliced"]);

export const JobOptionsSchema = z.object({
  cwd: z.string().min(1),
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().default(1_800_000),
  idleTimeoutMs: z.number().int().min(0).default(1_800_000),
  progressWarningMs: z.number().int().min(0).default(120_000),
  progressTimeoutMs: z.number().int().min(0).default(300_000),
  notify: NotifySchema.optional()
}).strict();

export const DevelopmentAcceptanceSchema = z.object({
  build: z.array(z.string().min(1)).optional(),
  test: z.array(z.string().min(1)).optional(),
  diffCheck: z.boolean().optional()
}).strict();

export const PlanInput = JobOptionsSchema.extend({
  task: z.string().min(1)
}).strict();

export const ImplementInput = JobOptionsSchema.extend({
  task: z.string().min(1),
  allowWrite: z.boolean(),
  acceptance: DevelopmentAcceptanceSchema.optional(),
  batchMode: BatchModeSchema.default("auto")
}).strict();

export const ReviewInput = JobOptionsSchema.extend({
  base: z.string().min(1).default("HEAD")
}).strict();

export const FixCiInput = JobOptionsSchema.extend({
  file: z.string().min(1),
  task: z.string().min(1).optional()
}).strict();

export const ResumeInput = JobOptionsSchema.extend({
  jobId: z.string().min(1),
  task: z.string().min(1).optional()
}).strict();

export const HealthcheckInput = z.object({
  cwd: z.string().optional()
}).strict();

export const ComposeWorkflowSchema = z.enum(COMPOSE_WORKFLOW_NAMES);

export const ComposeInputShape = {
  ...JobOptionsSchema.shape,
  workflow: ComposeWorkflowSchema,
  task: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  since: z.string().min(1).optional(),
  acceptance: DevelopmentAcceptanceSchema.optional(),
  verification: z.array(
    z.string().trim().min(1).describe(
      "One executable command with arguments; commands run without a shell"
    )
  ).optional().describe(
    "Executable verification commands, not natural-language acceptance criteria"
  ),
  reportDir: z.string().min(1).optional(),
  batchMode: BatchModeSchema.optional()
};

export const ComposeInput = z.object(ComposeInputShape).strict();

const ComposeInputWithWorkflowRequirements = ComposeInput.superRefine((input, context) => {
  for (const message of validateComposeWorkflowInput(input)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message });
  }
});

export function parseComposeInput(input: unknown): z.infer<typeof ComposeInput> {
  return normalizeComposeBatchMode(ComposeInputWithWorkflowRequirements.parse(input));
}

export const JobOutputLevelSchema = z.enum(["compact", "standard", "full"]);

export const JobStatusInput = z.object({
  cwd: z.string().min(1),
  jobId: z.string().optional(),
  level: JobOutputLevelSchema.default("compact")
}).strict();

export const JobEventsInput = z.object({
  cwd: z.string().min(1),
  jobId: z.string().optional(),
  sinceCursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(100).default(20),
  minLevel: z.enum(["debug", "info", "warn", "error"]).default("warn")
}).strict();

export const JobWaitInput = JobEventsInput.extend({
  timeoutMs: z.number().int().positive().default(1_800_000),
  // Wait must see completed/cancelled attention signals (level "info" in job-transition).
  minLevel: z.enum(["debug", "info", "warn", "error"]).default("info")
}).strict();

export const JobResultInput = z.object({
  cwd: z.string().min(1),
  jobId: z.string().optional(),
  level: JobOutputLevelSchema.default("compact")
}).strict();

export const JobCancelInput = z.object({
  cwd: z.string().min(1),
  jobId: z.string().min(1)
}).strict();

export const JobListInput = z.object({
  cwd: z.string().min(1),
  all: z.boolean().default(false)
}).strict();
