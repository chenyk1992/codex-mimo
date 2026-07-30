import { z } from "zod";
import {
  COMPOSE_WORKFLOW_NAMES,
  getComposeWorkflow,
  normalizeComposeBatchMode,
  validateComposeWorkflowInput
} from "../compose/workflow.js";
import { SINGLE_MODE_ALLOWED_PATHS_REQUIRED_MESSAGE } from "../core/safety-contracts.js";
import {
  allowedPathPatternsOverlap,
  validateAllowedPathPattern
} from "../core/path-scope.js";

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
  timeoutMs: z.number().int().positive().default(1_800_000),
  idleTimeoutMs: z.number().int().min(0).default(1_800_000),
  progressWarningMs: z.number().int().min(0).default(120_000),
  progressTimeoutMs: z.number().int().min(0).default(300_000),
  notify: NotifySchema.optional()
}).strict();

export const DevelopmentAcceptanceSchema = z.object({
  build: z.array(z.string().min(1)).optional(),
  test: z.array(z.string().min(1)).optional(),
  diffCheck: z.boolean().optional(),
  artifactPaths: z.array(z.string().min(1)).optional()
}).strict();

export const AllowedPathsSchema = z.array(z.string().min(1));

function collectAllowedPathsIssues(
  allowedPaths: string[] | undefined,
  options: { required: boolean }
): string[] {
  const issues: string[] = [];
  if (!allowedPaths || allowedPaths.length === 0) {
    if (options.required) {
      issues.push(SINGLE_MODE_ALLOWED_PATHS_REQUIRED_MESSAGE);
    }
    return issues;
  }

  for (const pattern of allowedPaths) {
    const error = validateAllowedPathPattern(pattern);
    if (error) {
      issues.push(`allowedPaths: ${error}`);
    }
  }
  return issues;
}

function collectArtifactPathIssues(
  allowedPaths: string[] | undefined,
  artifactPaths: string[] | undefined
): string[] {
  if (!artifactPaths) return [];
  const issues = artifactPaths.flatMap((pattern) => {
    const error = validateAllowedPathPattern(pattern);
    return error ? [`acceptance.artifactPaths: ${error}`] : [];
  });
  if (!allowedPaths) return issues;
  for (const artifactPath of artifactPaths) {
    for (const allowedPath of allowedPaths) {
      if (allowedPathPatternsOverlap(artifactPath, allowedPath)) {
        issues.push(
          `acceptance.artifactPaths must not overlap allowedPaths (${artifactPath}, ${allowedPath}).`
        );
      }
    }
  }
  return issues;
}

export const PlanInput = JobOptionsSchema.extend({
  task: z.string().min(1)
}).strict();

export const ImplementInputBase = JobOptionsSchema.extend({
  task: z.string().min(1),
  allowWrite: z.boolean(),
  acceptance: DevelopmentAcceptanceSchema.optional(),
  batchMode: BatchModeSchema.default("auto"),
  allowedPaths: AllowedPathsSchema.optional()
}).strict();

export const ImplementInput = ImplementInputBase.superRefine((input, context) => {
  for (const message of collectAllowedPathsIssues(input.allowedPaths, {
    required: input.batchMode === "single"
  })) {
    context.addIssue({ code: z.ZodIssueCode.custom, message });
  }
  for (const message of collectArtifactPathIssues(
    input.allowedPaths,
    input.acceptance?.artifactPaths
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, message });
  }
});

export const ReviewInput = JobOptionsSchema.extend({
  base: z.string().min(1).default("HEAD")
}).strict();

export const FixCiInput = JobOptionsSchema.extend({
  file: z.string().min(1),
  task: z.string().min(1).optional(),
  acceptance: DevelopmentAcceptanceSchema.optional(),
  allowedPaths: AllowedPathsSchema.optional()
}).strict();

const FixCiInputWithRequirements = FixCiInput.superRefine((input, context) => {
  for (const message of collectAllowedPathsIssues(input.allowedPaths, { required: false })) {
    context.addIssue({ code: z.ZodIssueCode.custom, message });
  }
  for (const message of collectArtifactPathIssues(
    input.allowedPaths,
    input.acceptance?.artifactPaths
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, message });
  }
});

export function parseFixCiInput(input: unknown): z.infer<typeof FixCiInput> {
  return FixCiInputWithRequirements.parse(input);
}

export const ResumeInput = JobOptionsSchema.extend({
  jobId: z.string().min(1),
  task: z.string().min(1).optional(),
  acceptance: DevelopmentAcceptanceSchema.optional(),
  allowedPaths: AllowedPathsSchema.optional()
}).strict();

const ResumeInputWithRequirements = ResumeInput.superRefine((input, context) => {
  for (const message of collectAllowedPathsIssues(input.allowedPaths, { required: false })) {
    context.addIssue({ code: z.ZodIssueCode.custom, message });
  }
  for (const message of collectArtifactPathIssues(
    input.allowedPaths,
    input.acceptance?.artifactPaths
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, message });
  }
});

export function parseResumeInput(input: unknown): z.infer<typeof ResumeInput> {
  return ResumeInputWithRequirements.parse(input);
}

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
  batchMode: BatchModeSchema.optional(),
  allowedPaths: AllowedPathsSchema.optional()
};

export const ComposeInput = z.object(ComposeInputShape).strict();

const ComposeInputWithWorkflowRequirements = ComposeInput.superRefine((input, context) => {
  for (const message of validateComposeWorkflowInput(input)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message });
  }

  const workflow = getComposeWorkflow(input.workflow);
  if (!workflow.writesAllowed && input.allowedPaths !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Workflow ${input.workflow} does not accept allowedPaths.`
    });
    return;
  }
  if (!workflow.writesAllowed && input.acceptance?.artifactPaths !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Workflow ${input.workflow} does not use acceptance.artifactPaths.`
    });
    return;
  }

  if (workflow.writesAllowed) {
    for (const message of collectAllowedPathsIssues(input.allowedPaths, { required: false })) {
      context.addIssue({ code: z.ZodIssueCode.custom, message });
    }
    for (const message of collectArtifactPathIssues(
      input.allowedPaths,
      input.acceptance?.artifactPaths
    )) {
      context.addIssue({ code: z.ZodIssueCode.custom, message });
    }
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
