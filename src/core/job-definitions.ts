import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import {
  createComposeReport,
  writeComposeReport,
  type ComposeReport
} from "../compose/report.js";
import {
  buildReadOnlyReportDiff,
  detectReadOnlyViolationFiles,
  gitHeadChanged,
  mergeChangedFiles,
  readOnlyViolationError
} from "../compose/post-checks.js";
import {
  compactVerification,
  normalizeVerificationCommands,
  runVerificationCommands,
  type VerificationCommandExecutor,
  type VerificationResult,
  type VerificationRunOptions
} from "../compose/verify.js";
import {
  normalizeDevelopmentAcceptancePlan,
  runDevelopmentAcceptance,
  runDiffAcceptanceSelfCheck,
  type AcceptanceStageResult,
  type DevelopmentAcceptancePlan,
  type DevelopmentAcceptanceResult
} from "../compose/acceptance.js";
import {
  diffReviewWarningsFromResult,
  runReadOnlyDiffReview
} from "../compose/diff-review.js";
import {
  buildComposePrompt,
  COMPOSE_WORKFLOW_NAMES,
  getComposeWorkflow,
  normalizeComposeBatchMode,
  validateComposeWorkflowInput,
  workflowSupportsBridgeSlicing,
  workflowRequiresDevelopmentAcceptance,
  type ComposeWorkflowName,
  type DevelopmentAcceptanceInput
} from "../compose/workflow.js";
import {
  extractFinalText,
  extractToolUseWritePaths,
  type MimoCommandEvidence,
  type NormalizedMimoEvent
} from "../compose/events.js";
import {
  captureGitDiff,
  captureGitReviewDiff,
  type GitCommitChangeSnapshot,
  type GitDiffSnapshot,
  type GitHeadSnapshot,
  type GitStatusSnapshot
} from "../git/diff.js";
import {
  preparePromptTransport,
  writePromptAttachment,
  type PromptTransportResult
} from "../mimo/prompt-transport.js";
import { buildMimoRunArgs } from "../mimo/run-json.js";
import type { StreamingRunResult } from "../mimo/streaming-runner.js";
import { preflightVerificationCommand } from "../compose/verify.js";
import {
  allowedPathPatternsOverlap,
  mergeAllowedPathScopes,
  runScopeCheck,
  validateAllowedPathPattern
} from "./path-scope.js";
import { isRuntimeArtifactPath } from "./runtime-paths.js";
import { CODEX_MIMO_READONLY_AGENT, SCOPE_CHECK_GATE } from "./safety-contracts.js";
import type { JobFailureCause } from "./jobs.js";
import { implementPrompt, planPrompt, resumeContinuationPrompt, resumePrompt, reviewPrompt } from "./prompt.js";
import { classifyRunOutcome, type JobOutcome, type RunEvidence } from "./job-outcome.js";
import {
  writeJobArtifacts,
  type WriteJobArtifactsInput
} from "./job-artifacts.js";
import {
  writeJobCheckpoint,
  readJobCheckpoint,
  type JobCheckpoint,
  captureRepositoryFingerprint,
  RESUMABLE_FAILURE_CODES
} from "./job-checkpoint.js";
import type {
  BatchMode,
  ExecutionCallbackSummary,
  JobAcceptanceSummary,
  JobKind,
  JobReconciliationSummary,
  JobReconciliationWarning,
  JobRecord,
  JobReportPaths,
  JobStatus,
  JobVerification,
  JobVerificationDetails
} from "./jobs.js";
import {
  planSliceManifest,
  type SliceDefinition,
  type SliceManifest
} from "../compose/slices.js";
import { renameWithWindowsRetry } from "./atomic-file.js";
import {
  createJobChainFromManifest,
  isChainOrchestratorRoot,
  isChainSliceChild,
  mapChildStatusToSliceState,
  markPendingSlicesCancelled,
  markSliceRunning,
  markSliceTerminal,
  readJobChain,
  readSliceManifestFromChain,
  selectNextReadySlice,
  unionChangedFiles,
  writeSliceManifestArtifact,
  type JobChainRecord,
  type SliceRuntimeState
} from "./job-chain.js";
import {
  createJobStore,
  readJob,
  updateJobAuthoritative,
  type CreateJobInput
} from "./job-store.js";
import { spawnJobSupervisor } from "./job-process.js";
import { transitionJob, type JobTransition } from "./job-transition.js";
import { execa } from "execa";
import {
  detectChangedFiles,
  type ChangeDetectionResult
} from "./changed-files.js";
import { redactDiagnosticText } from "./job-output.js";

const DEFAULT_TIMEOUT_MS = 1_800_000;

const BatchModeSchema = z.enum(["auto", "single", "sliced"]);

const CommonRequestSchema = z.object({
  cwd: z.string().min(1),
  timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
  idleTimeoutMs: z.number().int().min(0).default(DEFAULT_TIMEOUT_MS),
  progressWarningMs: z.number().int().min(0).default(120_000),
  progressTimeoutMs: z.number().int().min(0).default(300_000)
}).strict();

const DevelopmentAcceptanceRequestSchema = z.object({
  build: z.array(z.string().min(1)).optional(),
  test: z.array(z.string().min(1)).optional(),
  diffCheck: z.boolean().optional(),
  artifactPaths: z.array(z.string().min(1)).optional()
}).strict();

const PlanRequestSchema = CommonRequestSchema.extend({
  task: z.string().min(1)
});

const ImplementRequestSchema = CommonRequestSchema.extend({
  task: z.string().min(1),
  allowWrite: z.literal(true),
  acceptance: DevelopmentAcceptanceRequestSchema.optional(),
  allowedPaths: z.array(z.string().min(1)).optional(),
  batchMode: BatchModeSchema.default("auto")
}).superRefine((request, context) => {
  addArtifactScopeIssues(request.allowedPaths, request.acceptance?.artifactPaths, context);
});

const ReviewRequestSchema = CommonRequestSchema.extend({
  base: z.string().min(1).default("HEAD")
});

const FixCiRequestSchema = CommonRequestSchema.extend({
  file: z.string().min(1),
  task: z.string().min(1).optional(),
  acceptance: DevelopmentAcceptanceRequestSchema.optional()
}).superRefine((request, context) => {
  addArtifactScopeIssues(undefined, request.acceptance?.artifactPaths, context);
});

const JobExecutionPolicySchema = z.object({
  agent: z.enum(["plan", CODEX_MIMO_READONLY_AGENT, "build", "compose"]),
  writesAllowed: z.boolean()
}).strict();

const JobCheckpointSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),
  chainId: z.string().min(1),
  objective: z.string(),
  sessionId: z.string().nullable().optional(),
  repositoryFingerprint: z.string(),
  contextFiles: z.array(z.string()),
  changedFiles: z.array(z.string()),
  completedSlices: z.array(z.string()),
  completedChecklist: z.array(z.string()),
  remainingChecklist: z.array(z.string()),
  acceptance: z.object({
    stages: z.array(z.object({
      stage: z.enum(["build", "test", "diff_check"]),
      outcome: z.enum(["passed", "failed", "not_applicable", "pending"]),
      command: z.string().optional()
    })),
    failedStage: z.enum(["build", "test", "diff_check"]).optional(),
    failedCommand: z.string().optional(),
    failedTests: z.array(z.string()).optional(),
    suggestion: z.string().optional()
  }).passthrough(),
  artifactPaths: z.record(z.string()).optional()
}).passthrough();

const ResumeRequestSchema = CommonRequestSchema.extend({
  jobId: z.string().min(1),
  task: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  executionPolicy: JobExecutionPolicySchema,
  checkpoint: JobCheckpointSchema.optional(),
  requireAcceptance: z.boolean().default(false),
  acceptance: DevelopmentAcceptanceRequestSchema.optional(),
  allowedPaths: z.array(z.string().min(1)).optional()
}).superRefine((request, context) => {
  addArtifactScopeIssues(request.allowedPaths, request.acceptance?.artifactPaths, context);
});

const ComposeRequestSchema = CommonRequestSchema.extend({
  workflow: z.enum(COMPOSE_WORKFLOW_NAMES),
  task: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  since: z.string().min(1).optional(),
  verification: z.array(z.string().min(1)).optional(),
  reportDir: z.string().min(1).optional(),
  acceptance: DevelopmentAcceptanceRequestSchema.optional(),
  allowedPaths: z.array(z.string().min(1)).optional(),
  batchMode: BatchModeSchema.optional()
}).superRefine((request, context) => {
  for (const message of validateComposeWorkflowInput(request)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message });
  }
  const workflow = getComposeWorkflow(request.workflow);
  if (
    !workflow.writesAllowed &&
    request.acceptance?.artifactPaths !== undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Workflow ${request.workflow} does not use acceptance.artifactPaths.`
    });
    return;
  }
  addArtifactScopeIssues(request.allowedPaths, request.acceptance?.artifactPaths, context);
}).transform(normalizeComposeBatchMode);

function addArtifactScopeIssues(
  allowedPaths: string[] | undefined,
  artifactPaths: string[] | undefined,
  context: z.RefinementCtx
): void {
  if (!artifactPaths) return;
  for (const artifactPath of artifactPaths) {
    const error = validateAllowedPathPattern(artifactPath);
    if (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `acceptance.artifactPaths: ${error}`
      });
    }
    for (const allowedPath of allowedPaths ?? []) {
      if (allowedPathPatternsOverlap(artifactPath, allowedPath)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `acceptance.artifactPaths must not overlap allowedPaths (${artifactPath}, ${allowedPath}).`
        });
      }
    }
  }
}

export type PlanJobRequest = z.input<typeof PlanRequestSchema>;
export type ImplementJobRequest = z.input<typeof ImplementRequestSchema>;
export type ReviewJobRequest = z.input<typeof ReviewRequestSchema>;
export type FixCiJobRequest = z.input<typeof FixCiRequestSchema>;
export type ResumeJobRequest = z.input<typeof ResumeRequestSchema>;
export type ComposeJobRequest = z.input<typeof ComposeRequestSchema>;
export type JobExecutionPolicy = z.infer<typeof JobExecutionPolicySchema>;

export interface JobRequestByKind {
  plan: PlanJobRequest;
  implement: ImplementJobRequest;
  review: ReviewJobRequest;
  "fix-ci": FixCiJobRequest;
  resume: ResumeJobRequest;
  compose: ComposeJobRequest;
}

export interface JobFinalizeDependencies {
  runVerification?: (
    cwd: string,
    commands: string[],
    options?: VerificationRunOptions
  ) => Promise<VerificationResult[]>;
  runDevelopmentAcceptance?: (
    cwd: string,
    plan: DevelopmentAcceptancePlan,
    options?: {
      signal?: AbortSignal;
      runDiffCheck?: (cwd: string, signal?: AbortSignal) => Promise<AcceptanceStageResult>;
      execute?: VerificationCommandExecutor;
      commandEvidence?: MimoCommandEvidence[];
      finalRepositoryFingerprint?: string;
    }
  ) => Promise<DevelopmentAcceptanceResult>;
  runDiffCheck?: (cwd: string, signal?: AbortSignal) => Promise<AcceptanceStageResult>;
  runDiffAcceptanceSelfCheck?: typeof runDiffAcceptanceSelfCheck;
  runReadOnlyDiffReview?: typeof runReadOnlyDiffReview;
  captureDiff?: typeof captureGitDiff;
  executeVerification?: VerificationCommandExecutor;
  writeComposeReport?: (report: ComposeReport) => void;
  writeJobArtifacts?: (input: WriteJobArtifactsInput) => JobReportPaths;
  writeJobCheckpoint?: typeof writeJobCheckpoint;
}

export interface JobExecutionFinalizeContext {
  signal: AbortSignal;
  mimoArgs?: string[];
  /** Authoritative JSONL primary session captured by the job worker. */
  runSessionId?: string;
  /** True when JSONL emitted a different session after the primary was bound. */
  eventSessionMismatch?: boolean;
  /** Secondary/guard failure causes collected during the run. */
  failureCauses?: JobFailureCause[];
  run: StreamingRunResult;
  events: NormalizedMimoEvent[];
  executionCallback?: ExecutionCallbackSummary;
  gitStatusBefore?: GitStatusSnapshot;
  gitStatusAfter?: GitStatusSnapshot;
  gitHeadBefore?: GitHeadSnapshot;
  gitHeadAfter?: GitHeadSnapshot;
  diff?: GitDiffSnapshot;
  commitChanges?: GitCommitChangeSnapshot;
  changeDetection?: ChangeDetectionResult;
  commandEvidence?: MimoCommandEvidence[];
  finalRepositoryFingerprint?: string;
  reconciliationWarnings?: JobReconciliationWarning[];
  verification?: VerificationResult[];
  deps?: JobFinalizeDependencies;
}

export interface JobFinalizeContext<Request extends { cwd: string }> extends JobExecutionFinalizeContext {
  job: JobRecord;
  request: Request;
}

export interface JobDefinition<Kind extends JobKind, Request extends { cwd: string }> {
  kind: Kind;
  executionPolicy(request: Request): JobExecutionPolicy;
  buildPrompt(request: Request, signal: AbortSignal): Promise<PromptTransportResult>;
  buildMimoArgs(request: Request, prompt: PromptTransportResult): string[];
  finalize(context: JobFinalizeContext<Request>): Promise<JobOutcome>;
}

export type JobDefinitionRegistry = {
  [Kind in JobKind]: JobDefinition<Kind, JobRequestByKind[Kind]>;
};

export interface BoundJobDefinition {
  kind: JobKind;
  executionPolicy: JobExecutionPolicy;
  buildPrompt(signal: AbortSignal): Promise<PromptTransportResult>;
  buildMimoArgs(prompt: PromptTransportResult): string[];
  finalize(context: JobExecutionFinalizeContext): Promise<JobOutcome>;
}

const planDefinition: JobDefinition<"plan", PlanJobRequest> = directDefinition({
  kind: "plan",
  agent: CODEX_MIMO_READONLY_AGENT,
  writesAllowed: false,
  requireFinalText: true,
  prompt: (request) => planPrompt(request.task),
  title: "codex-mimo plan"
});

const implementDefinition: JobDefinition<"implement", ImplementJobRequest> = directDefinition({
  kind: "implement",
  agent: "build",
  writesAllowed: true,
  prompt: (request) => implementPrompt(request.task),
  title: "codex-mimo implement"
});

const reviewDefinition: JobDefinition<"review", ReviewJobRequest> = {
  kind: "review",
  executionPolicy: () => ({ agent: CODEX_MIMO_READONLY_AGENT, writesAllowed: false }),
  async buildPrompt(request, signal) {
    const base = request.base ?? "HEAD";
    const diff = await captureGitReviewDiff(request.cwd, base, { signal });
    const diffFile = diff.diff
      ? writePromptAttachment(diff.diff, { cwd: request.cwd, label: `review-${base}`, extension: ".diff" })
      : undefined;
    const prompt = preparePromptTransport(reviewPrompt(diffFile
      ? `Review the exact current diff against base ${base} attached as @${diffFile}.`
      : `No changes found against base ${base}.`), { cwd: request.cwd });
    return {
      ...prompt,
      files: mergeChangedFiles(prompt.files, diffFile ? [diffFile] : [])
    };
  },
  buildMimoArgs(request, prompt) {
    return buildMimoRunArgs({
      cwd: request.cwd,
      agent: CODEX_MIMO_READONLY_AGENT,
      message: prompt.message,
      title: "codex-mimo review",
      files: prompt.files
    });
  },
  async finalize(context) {
    return finalizeDirect(context, false);
  }
};

const fixCiDefinition: JobDefinition<"fix-ci", FixCiJobRequest> = directDefinition({
  kind: "fix-ci",
  agent: "build",
  writesAllowed: true,
  requireAcceptance: true,
  prompt: (request) => implementPrompt(request.task ?? "Fix the CI failures shown in the attached log."),
  files: (request) => [request.file],
  title: "codex-mimo fix-ci"
});

const resumeDefinition: JobDefinition<"resume", ResumeJobRequest> = {
  kind: "resume",
  executionPolicy: (request) => request.executionPolicy.writesAllowed
    ? { ...request.executionPolicy }
    : { agent: CODEX_MIMO_READONLY_AGENT, writesAllowed: false },
  async buildPrompt(request) {
    const task = request.task ?? request.checkpoint?.remainingChecklist[0] ?? "Continue the job.";
    const promptText = request.checkpoint
      ? resumeContinuationPrompt({
          objective: request.checkpoint.objective,
          checkpoint: request.checkpoint as JobCheckpoint,
          ...(request.task ? { task: request.task } : {})
        })
      : resumePrompt(task, request.executionPolicy.writesAllowed);
    return preparePromptTransport(promptText, { cwd: request.cwd });
  },
  buildMimoArgs(request, prompt) {
    return buildMimoRunArgs({
      cwd: request.cwd,
      agent: request.executionPolicy.writesAllowed
        ? request.executionPolicy.agent
        : CODEX_MIMO_READONLY_AGENT,
      ...(request.sessionId ? { session: request.sessionId } : {}),
      message: prompt.message,
      title: "codex-mimo resume",
      files: prompt.files
    });
  },
  async finalize(context) {
    return finalizeDirect(
      context,
      context.request.executionPolicy.writesAllowed,
      false,
      context.request.requireAcceptance
    );
  }
};

const composeDefinition: JobDefinition<"compose", ComposeJobRequest> = {
  kind: "compose",
  executionPolicy: (request) => {
    const writesAllowed = getComposeWorkflow(request.workflow).writesAllowed;
    return {
      agent: writesAllowed ? "build" : CODEX_MIMO_READONLY_AGENT,
      writesAllowed
    };
  },
  async buildPrompt(request) {
    const workflow = getComposeWorkflow(request.workflow);
    return preparePromptTransport(buildComposePrompt({
      workflow,
      task: request.task,
      file: request.file,
      since: request.since
    }), { cwd: request.cwd });
  },
  buildMimoArgs(request, prompt) {
    const writesAllowed = getComposeWorkflow(request.workflow).writesAllowed;
    return buildMimoRunArgs({
      cwd: request.cwd,
      agent: writesAllowed ? "build" : CODEX_MIMO_READONLY_AGENT,
      message: prompt.message,
      title: `codex-mimo compose ${request.workflow}`,
      files: mergeChangedFiles(prompt.files, request.file ? [request.file] : [])
    });
  },
  finalize: finalizeCompose
};

export const JOB_DEFINITIONS: JobDefinitionRegistry = {
  plan: planDefinition,
  implement: implementDefinition,
  review: reviewDefinition,
  "fix-ci": fixCiDefinition,
  resume: resumeDefinition,
  compose: composeDefinition
};

export function getJobDefinition<Kind extends JobKind>(
  kind: Kind
): JobDefinitionRegistry[Kind] {
  return JOB_DEFINITIONS[kind];
}

const JOB_BINDERS: Record<JobKind, (job: JobRecord) => BoundJobDefinition> = {
  plan: (job) => bind(job, PlanRequestSchema, planDefinition),
  implement: (job) => bind(job, ImplementRequestSchema, implementDefinition),
  review: (job) => bind(job, ReviewRequestSchema, reviewDefinition),
  "fix-ci": (job) => bind(job, FixCiRequestSchema, fixCiDefinition),
  resume: (job) => bind(job, ResumeRequestSchema, resumeDefinition),
  compose: (job) => bind(job, ComposeRequestSchema, composeDefinition)
};

export function bindJobDefinition(job: JobRecord): BoundJobDefinition {
  return JOB_BINDERS[job.kind](job);
}

function bind<Kind extends JobKind, Request extends { cwd: string }>(
  job: JobRecord,
  schema: z.ZodType<Request>,
  definition: JobDefinition<Kind, Request>
): BoundJobDefinition {
  const parsed = schema.safeParse(job.request);
  if (!parsed.success) {
    throw new Error(`Invalid ${job.kind} job request: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  const request = parsed.data;
  if (request.cwd !== job.cwd || definition.kind !== job.kind) {
    throw new Error(`Invalid ${job.kind} job request: stored job identity does not match the definition.`);
  }
  return {
    kind: definition.kind,
    executionPolicy: definition.executionPolicy(request),
    buildPrompt: (signal) => definition.buildPrompt(request, signal),
    buildMimoArgs: (prompt) => definition.buildMimoArgs(request, prompt),
    finalize: (context) => definition.finalize({ ...context, job, request })
  };
}

interface DirectDefinitionInput<
  Kind extends Exclude<JobKind, "compose" | "resume">,
  Request extends { cwd: string }
> {
  kind: Kind;
  agent: typeof CODEX_MIMO_READONLY_AGENT | "build";
  writesAllowed: boolean;
  requireFinalText?: boolean;
  requireAcceptance?: boolean;
  prompt: (request: Request) => string;
  files?: (request: Request) => string[];
  title: string;
}

function directDefinition<
  Kind extends Exclude<JobKind, "compose" | "resume">,
  Request extends { cwd: string }
>(
  input: DirectDefinitionInput<Kind, Request>
): JobDefinition<Kind, Request> {
  return {
    kind: input.kind,
    executionPolicy: () => ({ agent: input.agent, writesAllowed: input.writesAllowed }),
    async buildPrompt(request) {
      return preparePromptTransport(input.prompt(request), { cwd: request.cwd });
    },
    buildMimoArgs(request, prompt) {
      return buildMimoRunArgs({
        cwd: request.cwd,
        agent: input.agent,
        message: prompt.message,
        title: input.title,
        files: mergeChangedFiles(prompt.files, input.files?.(request) ?? [])
      });
    },
    async finalize(context) {
      return finalizeDirect(
        context,
        input.writesAllowed,
        input.requireFinalText === true,
        input.requireAcceptance
      );
    }
  };
}

async function finalizeDirect<Request extends { cwd: string; acceptance?: DevelopmentAcceptanceInput }>(
  context: JobFinalizeContext<Request>,
  writesAllowed: boolean,
  requireFinalText = false,
  requireAcceptance = context.job.kind === "implement"
): Promise<JobOutcome> {
  const changedFiles = collectChangedFiles(context);
  const initialOutcome = classifyRunOutcome(runEvidenceFromContext(context, {
    verification: [],
    ...(requireFinalText ? { requireFinalText: true } : {})
  }));
  const acceptanceRun = requireAcceptance && shouldRunAcceptance(initialOutcome)
    ? await runAcceptanceForFinalize(context, {
        writesAllowed,
        acceptance: context.request.acceptance,
        legacyVerification: undefined,
        changedFiles
      })
    : undefined;

  if (acceptanceRun?.missing) {
    const missingOutcome = needsInputIfOtherwiseComplete(
      context,
      acceptanceRun.missing,
      requireFinalText
    );
    return finalizeWithArtifacts(context, {
      ...missingOutcome,
      changedFiles
    }, [], writesAllowed);
  }

  const verificationDetails = acceptanceRun?.result?.verificationDetails ??
    (context.verification ?? []).map((entry) => ({
      command: entry.command,
      exitCode: entry.exitCode,
      passed: entry.passed,
      durationMs: entry.durationMs,
      stdout: "",
      stderr: ""
    }));
  const compact = acceptanceRun?.result
    ? compactVerificationFromAcceptance(acceptanceRun.result)
    : toCompactJobVerification(verificationDetails);
  const acceptanceSummary = acceptanceRun?.result
    ? toAcceptanceSummary(acceptanceRun.result)
    : undefined;

  let outcome = classifyRunOutcome(runEvidenceFromContext(context, {
    verification: compact,
    ...(requireFinalText ? { requireFinalText: true } : {})
  }));
  outcome = applyAcceptanceFailure(outcome, acceptanceRun?.result, compact, acceptanceSummary);

  const readOnlyViolationFiles = detectReadOnlyViolationFiles(
    writesAllowed,
    changedFiles,
    context.gitStatusBefore,
    context.gitStatusAfter
  );
  if (!writesAllowed && hasReadOnlyViolation(context, readOnlyViolationFiles)) {
    const error = readOnlyViolationError(
      context.job.kind,
      readOnlyViolationFiles,
      context.gitHeadBefore,
      context.gitHeadAfter
    );
    if (!outcome.errorCode?.startsWith("callback_")) {
      outcome = {
        ...outcome,
        status: "failed",
        summary: error,
        changedFiles: readOnlyViolationFiles,
        error,
        errorCode: "read_only_violation"
      };
    }
  }

  return finalizeWithArtifacts(context, {
    ...outcome,
    changedFiles: writesAllowed ? changedFiles : readOnlyViolationFiles,
    verification: compact,
    ...(acceptanceSummary ? { acceptance: acceptanceSummary } : {})
  }, verificationDetails, writesAllowed);
}

async function finalizeCompose(context: JobFinalizeContext<ComposeJobRequest>): Promise<JobOutcome> {
  const workflow = getComposeWorkflow(context.request.workflow);
  const requiresAcceptance = workflowRequiresDevelopmentAcceptance(workflow.name);
  const usesAcceptance = requiresAcceptance ||
    hasConfiguredDevelopmentAcceptance(context.request.acceptance);
  const changeDetection = collectChangeDetection(context);
  const detectedChangedFiles = changeDetection.files;
  const readOnlyViolationFiles = detectReadOnlyViolationFiles(
    workflow.writesAllowed,
    detectedChangedFiles,
    context.gitStatusBefore,
    context.gitStatusAfter
  );
  const changedFiles = workflow.writesAllowed
    ? detectedChangedFiles
    : readOnlyViolationFiles;
  let reportDiff = context.diff ?? emptyDiff();
  if (!workflow.writesAllowed) {
    reportDiff = buildReadOnlyReportDiff(reportDiff, changedFiles);
  } else if (changedFiles.length > 0) {
    reportDiff = { ...reportDiff, changedFiles };
  }

  let verificationDetails: JobVerificationDetails[] = [];
  let compact: JobVerification[] = [];
  let acceptanceResult: DevelopmentAcceptanceResult | undefined;
  let acceptanceMissing: { reason: string; code: "acceptance_config_missing" } | undefined;
  const initialOutcome = classifyRunOutcome(runEvidenceFromContext(context, {
    verification: [],
    ...(workflow.name === "plan" ? { requireFinalText: true } : {})
  }));

  if (usesAcceptance) {
    if (shouldRunAcceptance(initialOutcome)) {
      const acceptanceRun = await runAcceptanceForFinalize(context, {
        writesAllowed: workflow.writesAllowed,
        acceptance: context.request.acceptance,
        legacyVerification: context.request.verification,
        changedFiles,
        reportDiff
      });
      if (acceptanceRun.missing) {
        acceptanceMissing = acceptanceRun.missing;
      } else if (acceptanceRun.result) {
        acceptanceResult = acceptanceRun.result;
        verificationDetails = acceptanceResult.verificationDetails;
        compact = compactVerificationFromAcceptance(acceptanceResult);
      }
    }
  } else {
    const runVerification = context.deps?.runVerification ?? runVerificationCommands;
    const commands = normalizeVerificationCommands(
      context.request.verification,
      workflow.defaultVerification,
      context.request.cwd
    );
    context.signal.throwIfAborted();
    const verification = await runVerification(context.request.cwd, commands, {
      signal: context.signal,
      ...(context.deps?.executeVerification ? { execute: context.deps.executeVerification } : {})
    });
    context.signal.throwIfAborted();
    verificationDetails = verification;
    compact = compactVerification(verification);
  }

  const acceptanceSummary = acceptanceResult
    ? toAcceptanceSummary(acceptanceResult)
    : acceptanceMissing
      ? { stages: [] }
      : undefined;

  let outcome = acceptanceMissing
    ? needsInputIfOtherwiseComplete(context, acceptanceMissing, workflow.name === "plan")
    : classifyRunOutcome(runEvidenceFromContext(context, {
        verification: compact,
        ...(workflow.name === "plan" ? { requireFinalText: true } : {})
      }));
  outcome = applyAcceptanceFailure(outcome, acceptanceResult, compact, acceptanceSummary);

  const readOnlyError = !workflow.writesAllowed &&
      hasReadOnlyViolation(context, readOnlyViolationFiles)
    ? readOnlyViolationError(
      workflow.name,
      readOnlyViolationFiles,
      context.gitHeadBefore,
      context.gitHeadAfter
    )
    : undefined;
  const postCheckError = readOnlyError
    ? { message: readOnlyError, code: "read_only_violation" }
    : undefined;
  if (postCheckError && !outcome.errorCode?.startsWith("callback_")) {
    outcome = {
      ...outcome,
      status: "failed",
      summary: postCheckError.message,
      error: postCheckError.message,
      errorCode: postCheckError.code
    };
  }

  const composeStatus = composeReportStatus(
    outcome,
    toVerificationResults(verificationDetails),
    changedFiles,
    usesAcceptance
  );
  const assessment = composeStatus === "timeout" ? "failed" : composeStatus;

  const report = createComposeReport({
    id: context.job.id,
    createdAt: context.job.createdAt,
    workflow: workflow.name,
    cwd: context.request.cwd,
    requestedSkills: workflow.skillChain,
    status: composeStatus,
    events: context.events,
    diff: reportDiff,
    terminationReason: context.run.terminationReason,
    sessionId: outcome.sessionId ?? null,
    executionCallback: context.executionCallback,
    gitStatusBefore: context.gitStatusBefore,
    gitStatusAfter: context.gitStatusAfter,
    gitHeadBefore: context.gitHeadBefore,
    gitHeadAfter: context.gitHeadAfter,
    gitCommits: context.commitChanges?.commits,
    verification: toVerificationResults(verificationDetails),
    error: outcome.error,
    errorCode: outcome.errorCode,
    ...(outcome.causes && outcome.causes.length > 0 ? { failureCauses: outcome.causes } : {}),
    reportDir: context.request.reportDir ?? path.join(context.request.cwd, ".codex-mimo", "reports"),
    eventsDir: path.join(context.request.cwd, ".codex-mimo", "events"),
    diffsDir: path.join(context.request.cwd, ".codex-mimo", "diffs")
  });

  const baseReportPaths: JobReportPaths = {
    json: report.reportPaths.json,
    markdown: report.reportPaths.markdown,
    eventsJsonl: report.reportPaths.eventsJsonl,
    ...(report.diffPath ? { diff: report.diffPath } : {})
  };
  const writeArtifacts = context.deps?.writeJobArtifacts ?? writeJobArtifacts;
  const writeCheckpoint = context.deps?.writeJobCheckpoint ?? writeJobCheckpoint;
  const warnings: JobReconciliationWarning[] = [];
  let checkpointPaths: JobReportPaths = {};
  try {
    checkpointPaths = await writeCheckpoint({
      job: context.job,
      objective: context.job.task,
      changedFiles,
      acceptance: acceptanceSummary ?? outcome.acceptance,
      existingReportPaths: {
        ...context.job.reportPaths,
        ...baseReportPaths
      },
      reportDir: context.request.reportDir ??
        path.join(context.request.cwd, ".codex-mimo", "reports")
    });
  } catch {
    warnings.push({ code: "checkpoint_write_failed", stage: "checkpoint" });
  }
  let reportPaths: JobReportPaths = {
    ...context.job.reportPaths,
    ...baseReportPaths,
    ...checkpointPaths
  };
  try {
    reportPaths = writeArtifacts({
      job: context.job,
      status: outcome.status,
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      changedFiles,
      verification: verificationDetails,
      finalText: finalTextFrom(context),
      plan: workflow.name === "plan",
      reportDir: context.request.reportDir ??
        path.join(context.request.cwd, ".codex-mimo", "reports"),
      existingReportPaths: reportPaths
    });
  } catch {
    warnings.push({ code: "artifact_write_failed", stage: "artifacts" });
  }

  report.reportPaths = {
    json: report.reportPaths.json,
    markdown: report.reportPaths.markdown,
    eventsJsonl: report.reportPaths.eventsJsonl,
    ...(reportPaths.result ? { result: reportPaths.result } : {}),
    ...(reportPaths.plan ? { plan: reportPaths.plan } : {}),
    ...(reportPaths.verification ? { verification: reportPaths.verification } : {}),
    ...(reportPaths.checkpoint ? { checkpoint: reportPaths.checkpoint } : {})
  };
  context.signal.throwIfAborted();
  try {
    (context.deps?.writeComposeReport ?? writeComposeReport)(report);
  } catch {
    warnings.push({ code: "compose_report_write_failed", stage: "report" });
  }

  return {
    ...outcome,
    changedFiles,
    verification: compact,
    ...(acceptanceSummary || outcome.acceptance
      ? { acceptance: acceptanceSummary ?? outcome.acceptance }
      : {}),
    ...(outcome.causes && outcome.causes.length > 0 ? { failureCauses: outcome.causes } : {}),
    assessment,
    reportPaths,
    reconciliation: reconciliationSummary(
      changeDetection,
      warnings,
      context.reconciliationWarnings
    )
  };
}

function collectChangeDetection(
  context: JobFinalizeContext<{ cwd: string }>
): ChangeDetectionResult {
  if (context.changeDetection) return context.changeDetection;
  return detectChangedFiles({
    cwd: context.request.cwd,
    gitStatusBefore: context.gitStatusBefore,
    gitStatusAfter: context.gitStatusAfter,
    diff: context.diff,
    commitChanges: context.commitChanges,
    toolUsePaths: extractToolUseWritePaths(context.events)
  });
}

function collectChangedFiles(
  context: JobFinalizeContext<{ cwd: string }>
): string[] {
  return collectChangeDetection(context).files;
}

function excludeRuntimeChangedFiles(files: string[]): string[] {
  return files.filter((file) => !isRuntimeArtifactPath(file));
}

async function lookupExecutableOnPath(command: string): Promise<string | undefined> {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = await execa(lookup, [command], { reject: false });
  if (result.exitCode !== 0) return undefined;
  const line = result.stdout.trim().split(/\r?\n/).find((entry) => entry.trim().length > 0);
  return line?.trim();
}

function hasReadOnlyViolation(context: JobExecutionFinalizeContext, changedFiles: string[]): boolean {
  return changedFiles.length > 0 || gitHeadChanged(context.gitHeadBefore, context.gitHeadAfter);
}

function finalTextFrom(context: JobExecutionFinalizeContext): string {
  return extractFinalText(context.events);
}

function runEvidenceFromContext(
  context: JobExecutionFinalizeContext,
  patch: Partial<RunEvidence> = {}
): RunEvidence {
  const verification = patch.verification ?? [];
  return {
    exitCode: context.run.exitCode,
    terminationReason: context.run.terminationReason,
    ...(context.runSessionId !== undefined ? { runSessionId: context.runSessionId } : {}),
    ...(context.eventSessionMismatch ? { eventSessionMismatch: true } : {}),
    failureCauses: mergeFailureCauses(
      context.failureCauses,
      collectVerificationFailureCauses(verification)
    ),
    executionCallback: context.executionCallback,
    verification,
    finalText: finalTextFrom(context),
    ...patch
  };
}

function mergeFailureCauses(
  ...groups: Array<JobFailureCause[] | undefined>
): JobFailureCause[] | undefined {
  const merged: JobFailureCause[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!group) continue;
    for (const cause of group) {
      const key = `${cause.code}:${cause.stage}:${cause.command ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(cause);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

function collectVerificationFailureCauses(verification: JobVerification[]): JobFailureCause[] | undefined {
  const causes: JobFailureCause[] = [];
  for (const result of verification) {
    if (result.failureKind !== "command_not_found") continue;
    causes.push({
      code: "acceptance_command_unavailable",
      stage: inferVerificationStage(result.command),
      command: result.requestedCommand ?? result.command
    });
  }
  return causes.length > 0 ? causes : undefined;
}

function inferVerificationStage(command: string): JobFailureCause["stage"] {
  const normalized = command.trim().toLowerCase();
  if (/\btest\b/.test(normalized)) return "test";
  return "build";
}

export async function preflightWriteJobAcceptance(input: {
  cwd: string;
  kind: JobKind;
  request: unknown;
  signal?: AbortSignal;
}): Promise<
  | { ok: true }
  | {
      ok: false;
      code: "acceptance_config_missing" | "acceptance_command_unavailable";
      message: string;
      suggestion?: string;
      stage?: "build" | "test";
    }
> {
  input.signal?.throwIfAborted();
  const acceptance = readAcceptanceFromRequest(input.request);
  const legacyVerification = readLegacyVerificationFromRequest(input.request);
  const requiresAcceptance = input.kind === "implement" ||
    input.kind === "fix-ci" ||
    (
      input.kind === "resume" &&
      typeof input.request === "object" &&
      input.request !== null &&
      (input.request as { requireAcceptance?: unknown }).requireAcceptance === true
    ) ||
    (
      input.kind === "compose" &&
      typeof input.request === "object" &&
      input.request !== null &&
      "workflow" in input.request &&
      workflowRequiresDevelopmentAcceptance(
        (input.request as { workflow: ComposeWorkflowName }).workflow
      )
    );
  if (!requiresAcceptance) return { ok: true };

  const plan = normalizeDevelopmentAcceptancePlan({
    cwd: input.cwd,
    acceptance,
    legacyVerification,
    requireAcceptance: true
  });
  if ("missing" in plan && plan.missing) {
    if (input.kind !== "fix-ci" && input.kind !== "resume") {
      return { ok: true };
    }
    return {
      ok: false,
      code: plan.code,
      message: plan.reason
    };
  }
  const acceptancePlan = plan as DevelopmentAcceptancePlan;

  for (const stage of acceptancePlan.stages) {
    if (stage.stage !== "build" && stage.stage !== "test") continue;
    for (const command of stage.commands) {
      input.signal?.throwIfAborted();
      const result = await preflightVerificationCommand({
        cwd: input.cwd,
        command,
        source: acceptancePlan.source === "explicit" ? "explicit" : "detected",
        pathLookup: lookupExecutableOnPath
      });
      if (!result.ok) {
        return {
          ok: false,
          code: "acceptance_command_unavailable",
          message: result.message,
          ...(result.suggestion ? { suggestion: result.suggestion } : {}),
          stage: stage.stage
        };
      }
    }
  }

  return { ok: true };
}

function readAcceptanceFromRequest(request: unknown): DevelopmentAcceptanceInput | undefined {
  if (typeof request !== "object" || request === null || !("acceptance" in request)) {
    return undefined;
  }
  const value = (request as { acceptance?: unknown }).acceptance;
  return value && typeof value === "object"
    ? value as DevelopmentAcceptanceInput
    : undefined;
}

function hasConfiguredDevelopmentAcceptance(
  acceptance: DevelopmentAcceptanceInput | undefined
): boolean {
  return acceptance !== undefined && (
    acceptance.build !== undefined ||
    acceptance.test !== undefined ||
    acceptance.diffCheck !== undefined ||
    acceptance.artifactPaths !== undefined
  );
}

function readLegacyVerificationFromRequest(request: unknown): string[] | undefined {
  if (typeof request !== "object" || request === null || !("verification" in request)) {
    return undefined;
  }
  const value = (request as { verification?: unknown }).verification;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return value;
}

function emptyDiff(): GitDiffSnapshot {
  return { changedFiles: [], diffStat: "", diff: "" };
}

function composeReportStatus(
  outcome: JobOutcome,
  verification: VerificationResult[],
  changedFiles: string[],
  requiresAcceptance = false
): ComposeReport["status"] {
  if (outcome.status === "timeout") return "timeout";
  if (outcome.status !== "completed") return "failed";
  if (requiresAcceptance) return "passed";
  if (verification.length === 0 && changedFiles.length > 0) return "needs_review";
  return "passed";
}

async function finalizeWithArtifacts<Request extends { cwd: string }>(
  context: JobFinalizeContext<Request>,
  outcome: JobOutcome,
  verificationDetails: JobVerificationDetails[],
  _writesAllowed: boolean
): Promise<JobOutcome> {
  const writeArtifacts = context.deps?.writeJobArtifacts ?? writeJobArtifacts;
  const writeCheckpoint = context.deps?.writeJobCheckpoint ?? writeJobCheckpoint;
  const changedFiles = outcome.changedFiles ?? [];
  const warnings: JobReconciliationWarning[] = [];
  let checkpointPaths: JobReportPaths = {};
  try {
    checkpointPaths = await writeCheckpoint({
      job: context.job,
      objective: context.job.task,
      changedFiles,
      acceptance: outcome.acceptance,
      existingReportPaths: context.job.reportPaths
    });
  } catch {
    warnings.push({ code: "checkpoint_write_failed", stage: "checkpoint" });
  }
  let reportPaths: JobReportPaths = {
    ...context.job.reportPaths,
    ...checkpointPaths
  };
  try {
    reportPaths = writeArtifacts({
      job: context.job,
      status: outcome.status,
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      changedFiles,
      verification: verificationDetails,
      finalText: finalTextFrom(context),
      ...(context.diff?.diff ? { diff: context.diff.diff } : {}),
      plan: context.job.kind === "plan",
      existingReportPaths: reportPaths
    });
  } catch {
    warnings.push({ code: "artifact_write_failed", stage: "artifacts" });
  }
  const changeDetection = collectChangeDetection(context);
  return {
    ...outcome,
    changedFiles,
    verification: outcome.verification ?? toCompactJobVerification(verificationDetails),
    reportPaths,
    reconciliation: reconciliationSummary(
      changeDetection,
      warnings,
      context.reconciliationWarnings
    )
  };
}

function reconciliationSummary(
  changeDetection: ChangeDetectionResult,
  warnings: JobReconciliationWarning[],
  inheritedWarnings: JobReconciliationWarning[] = []
): JobReconciliationSummary {
  const allWarnings = [...inheritedWarnings, ...warnings].filter(
    (warning, index, entries) => entries.findIndex((candidate) =>
      candidate.code === warning.code && candidate.stage === warning.stage
    ) === index
  );
  return {
    status: allWarnings.length > 0 || changeDetection.status !== "complete"
      ? "degraded"
      : "complete",
    changeDetection: {
      status: changeDetection.status,
      sources: [...changeDetection.sources],
      candidates: [...changeDetection.candidates],
      ...(changeDetection.reason ? { reason: changeDetection.reason } : {})
    },
    ...(allWarnings.length > 0 ? { warnings: allWarnings } : {})
  };
}

function toCompactJobVerification(details: JobVerificationDetails[]): JobVerification[] {
  return details.map(({ command, exitCode, passed, durationMs, source }) => ({
    command,
    exitCode,
    passed,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(source ? { source } : {})
  }));
}

function toVerificationResults(details: JobVerificationDetails[]): VerificationResult[] {
  return details.map((entry) => ({
    command: entry.command,
    exitCode: entry.exitCode,
    stdout: entry.stdout,
    stderr: entry.stderr,
    passed: entry.passed,
    durationMs: entry.durationMs ?? 0
  }));
}

function needsInputIfOtherwiseComplete(
  context: JobExecutionFinalizeContext,
  missing: { reason: string; code: "acceptance_config_missing" },
  requireFinalText = false
): JobOutcome {
  const base = classifyRunOutcome(runEvidenceFromContext(context, {
    verification: [],
    ...(requireFinalText ? { requireFinalText: true } : {})
  }));
  if (base.status !== "completed") return base;
  return {
    status: "needs_input",
    summary: missing.reason,
    error: missing.reason,
    errorCode: missing.code,
    verification: [],
    acceptance: { stages: [] },
    ...(base.sessionId !== undefined ? { sessionId: base.sessionId } : {}),
    ...(base.executionCallback ? { executionCallback: base.executionCallback } : {})
  };
}

function applyAcceptanceFailure(
  outcome: JobOutcome,
  acceptance: DevelopmentAcceptanceResult | undefined,
  compact: JobVerification[],
  summary?: JobAcceptanceSummary
): JobOutcome {
  if (!acceptance) {
    return summary ? { ...outcome, acceptance: summary } : outcome;
  }
  const acceptanceSummary = summary ?? toAcceptanceSummary(acceptance);
  if (acceptance.passed) {
    return { ...outcome, verification: compact, acceptance: acceptanceSummary };
  }
  if (
    outcome.errorCode?.startsWith("callback_") ||
    outcome.errorCode === "prompt_identity_mismatch" ||
    outcome.errorCode === "callback_session_mismatch" ||
    outcome.errorCode === "event_session_mismatch" ||
    outcome.status === "cancelled" ||
    outcome.status === "stalled" ||
    outcome.status === "needs_input" ||
    outcome.status === "blocked"
  ) {
    return { ...outcome, verification: compact, acceptance: acceptanceSummary };
  }
  if (outcome.status === "timeout") {
    const secondaryCode = acceptance.errorCode ?? "verification_failed";
    const secondaryStage = acceptance.failedStage ?? "build";
    const causes = [
      ...(outcome.causes ?? [{ code: outcome.errorCode ?? "timeout", stage: "execution" as const }]),
      {
        code: secondaryCode,
        stage: secondaryStage,
        ...(acceptance.failedCommand ? { command: acceptance.failedCommand } : {}),
        ...(acceptance.suggestion ? { suggestion: acceptance.suggestion } : {})
      }
    ];
    return {
      ...outcome,
      verification: compact,
      acceptance: acceptanceSummary,
      causes
    };
  }
  if (outcome.status !== "completed" && outcome.errorCode !== "verification_failed") {
    return { ...outcome, verification: compact, acceptance: acceptanceSummary };
  }
  const errorCode = acceptance.errorCode ?? "verification_failed";
  const message = acceptance.suggestion ??
    acceptance.failedCommand ??
    "MiMoCode acceptance failed.";
  return {
    ...outcome,
    status: "failed",
    summary: message,
    error: message,
    errorCode,
    verification: compact,
    acceptance: acceptanceSummary
  };
}

function shouldRunAcceptance(outcome: JobOutcome): boolean {
  return outcome.errorCode !== "prompt_identity_mismatch";
}

function toAcceptanceSummary(result: DevelopmentAcceptanceResult): JobAcceptanceSummary {
  return {
    stages: result.stages.map((stage) => ({
      stage: stage.stage,
      outcome: stage.outcome === "skipped" ? "pending" : stage.outcome,
      ...(stage.command !== undefined ? { command: stage.command } : {})
    })),
    ...(result.failedStage ? { failedStage: result.failedStage } : {}),
    ...(result.failedCommand ? { failedCommand: result.failedCommand } : {}),
    ...(result.failedTests ? { failedTests: result.failedTests } : {}),
    ...(result.suggestion ? { suggestion: result.suggestion } : {})
  };
}

function compactVerificationFromAcceptance(
  result: DevelopmentAcceptanceResult
): JobVerification[] {
  const fromCommands = toCompactJobVerification(result.verificationDetails);
  if (result.failedStage === "diff_check" && result.passed === false) {
    return [
      ...fromCommands,
      {
        command: result.failedCommand ?? "diff_check",
        exitCode: 1,
        passed: false
      }
    ];
  }
  return fromCommands;
}

async function runAcceptanceForFinalize<Request extends { cwd: string }>(
  context: JobFinalizeContext<Request>,
  input: {
    writesAllowed: boolean;
    acceptance?: DevelopmentAcceptanceInput;
    legacyVerification?: string[];
    changedFiles: string[];
    reportDiff?: GitDiffSnapshot;
  }
): Promise<{
  missing?: { reason: string; code: "acceptance_config_missing" };
  result?: DevelopmentAcceptanceResult;
}> {
  const plan = normalizeDevelopmentAcceptancePlan({
    cwd: context.request.cwd,
    acceptance: input.acceptance,
    legacyVerification: input.legacyVerification,
    requireAcceptance: true
  });
  if ("missing" in plan && plan.missing) {
    return { missing: { reason: plan.reason, code: plan.code } };
  }

  const acceptancePlan = plan as DevelopmentAcceptancePlan;
  const allowedPaths = readAllowedPathsFromRequest(context.request);
  const scopePaths = mergeAllowedPathScopes(allowedPaths, input.acceptance?.artifactPaths);
  if (input.writesAllowed && allowedPaths && allowedPaths.length > 0) {
    const scope = runScopeCheck({
      changedFiles: input.changedFiles,
      allowedPaths: scopePaths ?? allowedPaths
    });
    if (!scope.passed) {
      const reason = scope.reason ?? "Write scope check failed.";
      return {
        result: {
          passed: false,
          stages: [{
            stage: "diff_check",
            outcome: "failed",
            command: SCOPE_CHECK_GATE,
            reason: `${SCOPE_CHECK_GATE}: ${reason}`
          }],
          verificationDetails: [{
            command: SCOPE_CHECK_GATE,
            exitCode: 1,
            passed: false,
            stdout: JSON.stringify({
              gate: SCOPE_CHECK_GATE,
              outOfScopePaths: scope.outOfScopePaths
            }),
            stderr: reason
          }],
          compactTests: [{
            stage: "diff_check",
            command: SCOPE_CHECK_GATE,
            outcome: "failed"
          }],
          errorCode: "write_scope_violation",
          failedStage: "diff_check",
          failedCommand: SCOPE_CHECK_GATE,
          suggestion: scope.suggestion
        }
      };
    }
  }

  const diffPath = ensureDiffArtifact(context, input.reportDiff ?? context.diff);
  const runAcceptance = context.deps?.runDevelopmentAcceptance ?? runDevelopmentAcceptance;
  const runDiffCheck = context.deps?.runDiffCheck ??
    createDefaultRunDiffCheck(context, input.writesAllowed, diffPath);

  context.signal.throwIfAborted();
  const result = await runAcceptance(context.request.cwd, acceptancePlan, {
    signal: context.signal,
    runDiffCheck,
    ...(context.deps?.executeVerification ? { execute: context.deps.executeVerification } : {}),
    ...(context.commandEvidence ? { commandEvidence: context.commandEvidence } : {}),
    ...(context.finalRepositoryFingerprint
      ? { finalRepositoryFingerprint: context.finalRepositoryFingerprint }
      : {})
  });
  context.signal.throwIfAborted();

  // Surface read-only review warnings into verification artifact details when present.
  const diffStage = result.stages.find((stage) => stage.stage === "diff_check");
  if (diffStage) {
    const warnings = diffReviewWarningsFromResult(diffStage);
    if (warnings.length > 0) {
      result.verificationDetails.push({
        command: "diff_check:review_warnings",
        exitCode: 0,
        passed: true,
        stdout: JSON.stringify({ warnings }),
        stderr: ""
      });
    }
  }

  return { result };
}

function ensureDiffArtifact(
  context: JobFinalizeContext<{ cwd: string }>,
  diff: GitDiffSnapshot | undefined
): string | undefined {
  const text = diff?.diff?.trim();
  if (!text) return undefined;
  const diffsDir = path.join(context.request.cwd, ".codex-mimo", "diffs");
  try {
    fs.mkdirSync(diffsDir, { recursive: true });
    const diffPath = path.join(diffsDir, `${context.job.id}.diff`);
    fs.writeFileSync(diffPath, redactDiagnosticText(text), "utf8");
    return diffPath;
  } catch {
    recordReconciliationWarning(context, {
      code: "diff_artifact_write_failed",
      stage: "diff_artifact"
    });
    return undefined;
  }
}

function hasUsableDiffFile(diffPath: string | undefined): boolean {
  if (!diffPath || !fs.existsSync(diffPath)) return false;
  try {
    return fs.readFileSync(diffPath, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

async function resolveDiffPathForReview(
  context: JobFinalizeContext<{ cwd: string }>,
  initialDiffPath: string | undefined,
  captureDiff: typeof captureGitDiff,
  signal?: AbortSignal
): Promise<string | undefined> {
  if (hasUsableDiffFile(initialDiffPath)) {
    return initialDiffPath;
  }
  const existing = context.job.reportPaths?.diff;
  if (hasUsableDiffFile(existing)) {
    return existing;
  }
  const fromContext = ensureDiffArtifact(context, context.diff);
  if (fromContext) return fromContext;

  try {
    const snapshot = await captureDiff(context.request.cwd, "HEAD", { signal });
    return ensureDiffArtifact(context, snapshot);
  } catch {
    recordReconciliationWarning(context, {
      code: "diff_artifact_write_failed",
      stage: "diff_artifact"
    });
    return undefined;
  }
}

function createDefaultRunDiffCheck(
  context: JobFinalizeContext<{ cwd: string }>,
  writesAllowed: boolean,
  initialDiffPath: string | undefined
): (cwd: string, signal?: AbortSignal) => Promise<AcceptanceStageResult> {
  return async (cwd, signal) => {
    const runSelfCheck = context.deps?.runDiffAcceptanceSelfCheck ?? runDiffAcceptanceSelfCheck;
    const runReview = context.deps?.runReadOnlyDiffReview ?? runReadOnlyDiffReview;
    const captureDiff = context.deps?.captureDiff ?? captureGitDiff;

    const allowedPaths = readAllowedPathsFromRequest(context.request);
    const artifactPaths = readAcceptanceFromRequest(context.request)?.artifactPaths;
    const scopePaths = mergeAllowedPathScopes(allowedPaths, artifactPaths);
    const selfCheck = await runSelfCheck({
      cwd,
      expectedWritesAllowed: writesAllowed,
      gitHeadBefore: context.gitHeadBefore,
      signal,
      ...(scopePaths ? { allowedPaths: scopePaths } : {})
    });
    if (selfCheck.outcome === "failed") {
      return selfCheck;
    }

    const changedFileCount = selfCheck.summary?.changedFileCount ?? 0;
    const hasWorkspaceChanges = changedFileCount > 0;

    if (!hasWorkspaceChanges && !hasUsableDiffFile(initialDiffPath)) {
      // Align with runReadOnlyDiffReview no_diff → not_applicable → passed.
      return { stage: "diff_check", outcome: "passed" };
    }
    if (!shouldRunSemanticDiffReview(context, selfCheck)) {
      return {
        stage: "diff_check",
        outcome: "passed",
        reason: "deterministic_check_sufficient"
      };
    }

    const diffPath = await resolveDiffPathForReview(
      context,
      initialDiffPath,
      captureDiff,
      signal
    );
    if (!diffPath) {
      if (context.reconciliationWarnings?.some(
        (warning) => warning.code === "diff_artifact_write_failed"
      )) {
        return {
          stage: "diff_check",
          outcome: "passed",
          reason: "semantic_review_unavailable"
        };
      }
      return {
        stage: "diff_check",
        outcome: "failed",
        reason: "delivery_contract_missing",
        suggestion:
          "Could not produce a diff artifact for read-only review despite workspace changes."
      };
    }

    const review = await runReview({
      cwd,
      sessionId: context.executionCallback?.sessionId ?? context.job.sessionId,
      diffPath,
      signal
    });
    if (review.outcome === "not_applicable") {
      if (hasWorkspaceChanges) {
        return {
          stage: "diff_check",
          outcome: "failed",
          reason: "delivery_contract_missing",
          suggestion:
            "Diff review reported no_diff despite workspace changes; refresh the diff artifact and rerun."
        };
      }
      return { stage: "diff_check", outcome: "passed" };
    }
    return review;
  };
}

function recordReconciliationWarning(
  context: JobExecutionFinalizeContext,
  warning: JobReconciliationWarning
): void {
  const current = context.reconciliationWarnings ?? [];
  if (!current.some((candidate) =>
    candidate.code === warning.code && candidate.stage === warning.stage
  )) {
    current.push(warning);
  }
  context.reconciliationWarnings = current;
}

function shouldRunSemanticDiffReview(
  context: JobFinalizeContext<{ cwd: string }>,
  selfCheck: Awaited<ReturnType<typeof runDiffAcceptanceSelfCheck>>
): boolean {
  if (context.changeDetection?.status !== undefined &&
      context.changeDetection.status !== "complete") {
    return true;
  }
  const workflow = typeof context.request === "object" && context.request !== null &&
      "workflow" in context.request
    ? String((context.request as Record<string, unknown>).workflow ?? "")
    : "";
  if (workflow === "fix-ci" || workflow === "merge") return true;

  const files = selfCheck.summary?.samplePaths ?? context.diff?.changedFiles ?? [];
  if ((selfCheck.summary?.changedFileCount ?? files.length) > 5) return true;
  if (files.some(isSensitiveReviewPath)) return true;
  return estimatedChangedLines(context.diff) > 200;
}

function isSensitiveReviewPath(file: string): boolean {
  const normalized = file.replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pom\.xml|build\.gradle(?:\.kts)?|cargo\.lock)$/.test(normalized) ||
    /(^|\/)(auth|security|permissions?|migrations?)([._/-]|$)/.test(normalized) ||
    /(^|\/)\.github\/workflows(\/|$)/.test(normalized);
}

function estimatedChangedLines(diff: GitDiffSnapshot | undefined): number {
  if (!diff) return 0;
  const statMatch = diff.diffStat.match(/(\d+)\s+insertion(?:s)?\(\+\)/);
  const deletionMatch = diff.diffStat.match(/(\d+)\s+deletion(?:s)?\(-\)/);
  if (statMatch || deletionMatch) {
    return Number.parseInt(statMatch?.[1] ?? "0", 10) +
      Number.parseInt(deletionMatch?.[1] ?? "0", 10);
  }
  return diff.diff.split(/\r?\n/).filter((line) =>
    (line.startsWith("+") && !line.startsWith("+++")) ||
    (line.startsWith("-") && !line.startsWith("---"))
  ).length;
}

function readAllowedPathsFromRequest(request: unknown): string[] | undefined {
  if (typeof request !== "object" || request === null || !("allowedPaths" in request)) {
    return undefined;
  }
  const value = (request as { allowedPaths?: unknown }).allowedPaths;
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return value;
}

/**
 * Task 5/7: for write roots with batchMode auto|single|sliced, plan a slice manifest,
 * materialize the durable chain, and spawn the first child (null notify).
 * Root becomes an orchestrator and skips write MiMo.
 *
 * Task 6 advances the chain after each child terminal via advanceJobChainAfterChild.
 */
export type WriteChainBootstrapResult =
  | { status: "skipped" }
  | { status: "failed"; errorCode: "slice_plan_invalid"; reason: string }
  | { status: "needs_input"; errorCode: "acceptance_config_missing"; reason: string }
  | {
      status: "bootstrapped";
      chainId: string;
      childJobId: string;
      sliceId: string;
      summary: string;
      reportPaths: JobReportPaths;
      root: JobRecord;
      child: JobRecord;
    };

export interface WriteChainBootstrapDependencies {
  planSliceManifest?: typeof planSliceManifest;
  captureRepositoryFingerprint?: typeof captureRepositoryFingerprint;
  createChildJob?: (cwd: string, input: CreateJobInput) => JobRecord;
  spawnJobSupervisor?: typeof spawnJobSupervisor;
  updateRoot?: typeof updateJobAuthoritative;
  writeSliceManifestArtifact?: typeof writeSliceManifestArtifact;
  createJobChainFromManifest?: typeof createJobChainFromManifest;
  markSliceRunning?: typeof markSliceRunning;
  selectNextReadySlice?: typeof selectNextReadySlice;
}

export function shouldBootstrapWriteJobChain(job: JobRecord): boolean {
  if (job.parentJobId || job.sliceId) {
    return false;
  }
  if (isChainOrchestratorRoot(job)) {
    return false;
  }
  if (job.kind === "implement") {
    const parsed = ImplementRequestSchema.safeParse(job.request);
    if (!parsed.success) return false;
    return isBootstrapBatchMode(parsed.data.batchMode);
  }
  if (job.kind === "compose") {
    const parsed = ComposeRequestSchema.safeParse(job.request);
    if (!parsed.success) return false;
    const workflow = getComposeWorkflow(parsed.data.workflow);
    if (!workflow.writesAllowed || !workflowSupportsBridgeSlicing(workflow.name)) {
      return false;
    }
    return isBootstrapBatchMode(parsed.data.batchMode);
  }
  return false;
}

function isBootstrapBatchMode(batchMode: BatchMode | undefined): boolean {
  return batchMode === "auto" || batchMode === "single" || batchMode === "sliced";
}

export async function bootstrapWriteJobChain(
  job: JobRecord,
  deps: WriteChainBootstrapDependencies = {},
  signal?: AbortSignal
): Promise<WriteChainBootstrapResult> {
  if (!shouldBootstrapWriteJobChain(job)) {
    return { status: "skipped" };
  }

  const plan = resolveChainRootPlanInput(job);
  if (!plan) {
    return { status: "skipped" };
  }
  const requireAcceptance = job.kind === "implement" ||
    (
      plan.workflow !== undefined &&
      workflowRequiresDevelopmentAcceptance(plan.workflow)
    ) ||
    hasConfiguredDevelopmentAcceptance(plan.acceptance);
  if (requireAcceptance) {
    const acceptancePlan = normalizeDevelopmentAcceptancePlan({
      cwd: job.cwd,
      acceptance: plan.acceptance,
      legacyVerification: plan.legacyVerification,
      requireAcceptance: true
    });
    if ("missing" in acceptancePlan) {
      return {
        status: "needs_input",
        errorCode: acceptancePlan.code,
        reason: acceptancePlan.reason
      };
    }
  }

  const chainId = `chain-${job.id}`;
  const captureFingerprint = deps.captureRepositoryFingerprint ?? captureRepositoryFingerprint;
  const repositoryFingerprint = await captureFingerprint(job.cwd, []);
  signal?.throwIfAborted();

  const planManifest = deps.planSliceManifest ?? planSliceManifest;
  const planned = await planManifest({
    cwd: job.cwd,
    chainId,
    objective: plan.objective,
    batchMode: plan.batchMode,
    acceptance: plan.acceptance,
    legacyVerification: plan.legacyVerification,
    repositoryFingerprint,
    ...(plan.allowedPaths ? { allowedPaths: plan.allowedPaths } : {}),
    requireAcceptance,
    signal
  });
  signal?.throwIfAborted();

  if (!planned.ok) {
    return {
      status: "failed",
      errorCode: "slice_plan_invalid",
      reason: planned.reason
    };
  }

  const writeManifest = deps.writeSliceManifestArtifact ?? writeSliceManifestArtifact;
  const createChain = deps.createJobChainFromManifest ?? createJobChainFromManifest;
  const pickReady = deps.selectNextReadySlice ?? selectNextReadySlice;
  const markRunning = deps.markSliceRunning ?? markSliceRunning;
  const updateRoot = deps.updateRoot ?? updateJobAuthoritative;
  const createChild = deps.createChildJob ?? ((cwd, input) => createJobStore(cwd).create(input));
  const spawnSupervisor = deps.spawnJobSupervisor ?? spawnJobSupervisor;

  const manifestPath = writeManifest({
    cwd: job.cwd,
    rootJobId: job.id,
    manifest: planned.manifest
  });
  const chain = createChain({
    cwd: job.cwd,
    rootJobId: job.id,
    manifest: planned.manifest,
    manifestPath
  });
  const slice = pickReady(planned.manifest, chain);
  if (!slice) {
    return {
      status: "failed",
      errorCode: "slice_plan_invalid",
      reason: "Slice plan produced no dependency-ready slice to start."
    };
  }

  const childRequest = buildSliceChildRequest(job, plan, slice);
  const child = createChild(job.cwd, {
    kind: job.kind,
    task: slice.objective,
    request: childRequest,
    parentJobId: job.id,
    chainId: planned.manifest.chainId,
    sliceId: slice.id
    // notificationTarget omitted — children must not notify
  });
  spawnSupervisor(job.cwd);
  markRunning(job.cwd, planned.manifest.chainId, slice.id, child.id);

  const sliceIndex = planned.manifest.slices.findIndex((entry) => entry.id === slice.id) + 1;
  const summary = `Executing slice ${sliceIndex}/${planned.manifest.slices.length}: ${slice.title}`;
  const reportPaths: JobReportPaths = {
    ...(job.reportPaths ?? {}),
    slices: manifestPath.replace(/\\/g, "/")
  };
  const root = await updateRoot(job.cwd, job.id, {
    chainId: planned.manifest.chainId,
    summary,
    phase: "editing",
    reportPaths
  });

  return {
    status: "bootstrapped",
    chainId: planned.manifest.chainId,
    childJobId: child.id,
    sliceId: slice.id,
    summary,
    reportPaths,
    root,
    child
  };
}

export interface AdvanceJobChainAfterChildResult {
  root: JobRecord;
  startedChildId?: string;
  rootTerminal?: boolean;
  deliveryCreated?: boolean;
  ignored?: boolean;
}

export interface AdvanceJobChainAfterChildDependencies {
  readJob?: typeof readJob;
  transitionJob?: typeof transitionJob;
  updateRoot?: typeof updateJobAuthoritative;
  createChildJob?: (cwd: string, input: CreateJobInput) => JobRecord;
  spawnJobSupervisor?: typeof spawnJobSupervisor;
  markSliceTerminal?: typeof markSliceTerminal;
  markSliceRunning?: typeof markSliceRunning;
  markPendingSlicesCancelled?: typeof markPendingSlicesCancelled;
  selectNextReadySlice?: typeof selectNextReadySlice;
  readJobChain?: typeof readJobChain;
  readSliceManifest?: typeof readSliceManifestFromChain;
  writeRootCheckpoint?: typeof refreshRootChainCheckpoint;
}

/**
 * After a chain child reaches a durable terminal status: mark the slice, aggregate
 * onto the root, then either start the next ready slice (null notify), finalize the
 * root as completed, or mirror attention onto the root (root-only notification).
 * Cancelled / cancel-requested roots never spawn further slices.
 */
export async function advanceJobChainAfterChild(input: {
  cwd: string;
  child: JobRecord;
}, deps: AdvanceJobChainAfterChildDependencies = {}): Promise<AdvanceJobChainAfterChildResult> {
  const child = input.child;
  if (!isChainSliceChild(child)) {
    return { root: child, ignored: true };
  }

  const sliceState = mapChildStatusToSliceState(child.status);
  if (!sliceState) {
    return { root: child, ignored: true };
  }

  const loadJob = deps.readJob ?? readJob;
  const root = loadJob(input.cwd, child.parentJobId!);
  if (!root) {
    throw new Error(`Chain root job "${child.parentJobId}" was not found.`);
  }

  const loadChain = deps.readJobChain ?? readJobChain;
  const chainBefore = loadChain(input.cwd, child.chainId!);
  if (!chainBefore) {
    throw new Error(`Job chain "${child.chainId}" was not found.`);
  }

  const priorState = chainBefore.sliceStates[child.sliceId!];
  if (priorState && priorState !== "pending" && priorState !== "running") {
    return {
      root,
      rootTerminal: isTerminalJobStatus(root.status),
      ignored: true
    };
  }

  const markTerminal = deps.markSliceTerminal ?? markSliceTerminal;
  const chain = markTerminal(input.cwd, child.chainId!, child.sliceId!, sliceState);

  const changedFiles = unionChangedFiles(root.changedFiles, child.changedFiles);
  const verification = [...root.verification, ...child.verification];
  const acceptance = mergeAcceptanceSummaries(root.acceptance, child.acceptance);
  const reportPaths: JobReportPaths = {
    ...(root.reportPaths ?? {}),
    ...(child.reportPaths?.markdown ? { markdown: child.reportPaths.markdown } : {}),
    ...(child.reportPaths?.json ? { json: child.reportPaths.json } : {}),
    ...(child.reportPaths?.result ? { result: child.reportPaths.result } : {}),
    ...(child.reportPaths?.diff ? { diff: child.reportPaths.diff } : {}),
    ...(child.reportPaths?.verification ? { verification: child.reportPaths.verification } : {}),
    ...(child.reportPaths?.checkpoint ? { checkpoint: child.reportPaths.checkpoint } : {})
  };

  const writeCheckpoint = deps.writeRootCheckpoint ?? refreshRootChainCheckpoint;
  await writeCheckpoint({
    cwd: input.cwd,
    root: { ...root, changedFiles, verification, acceptance, reportPaths },
    chain,
    changedFiles
  });

  const updateRoot = deps.updateRoot ?? updateJobAuthoritative;
  const transition = deps.transitionJob ?? transitionJob;
  const cancelPending = deps.markPendingSlicesCancelled ?? markPendingSlicesCancelled;
  const freshRoot = loadJob(input.cwd, root.id) ?? root;

  if (!canContinueChainOrchestration(freshRoot)) {
    cancelPending(input.cwd, chain.chainId);
    if (freshRoot.status === "running" && freshRoot.cancellationRequestedAt) {
      const cancelled = await transition(input.cwd, root.id, {
        status: "cancelled",
        summary: `Cancelled ${root.id}.`,
        errorCode: "cancelled",
        changedFiles,
        verification,
        ...(acceptance ? { acceptance } : {}),
        reportPaths
      });
      return {
        root: cancelled.job,
        rootTerminal: true,
        deliveryCreated: cancelled.deliveryCreated
      };
    }
    return {
      root: freshRoot,
      rootTerminal: isTerminalJobStatus(freshRoot.status),
      ignored: true
    };
  }

  if (sliceState !== "completed") {
    if (sliceState === "cancelled") {
      cancelPending(input.cwd, chain.chainId);
    }
    if (sliceState === "failed" && !isResumableSliceFailure(child)) {
      cancelPending(input.cwd, chain.chainId);
    }
    const attention = buildRootAttentionTransition({
      child,
      sliceState,
      changedFiles,
      verification,
      acceptance,
      reportPaths
    });
    const result = await transition(input.cwd, root.id, attention);
    return {
      root: result.job,
      rootTerminal: true,
      deliveryCreated: result.deliveryCreated
    };
  }

  return startNextReadySliceOrFinalizeRoot({
    cwd: input.cwd,
    root: { ...freshRoot, changedFiles, verification, acceptance, reportPaths },
    chain,
    changedFiles,
    verification,
    acceptance,
    reportPaths,
    deps: {
      ...deps,
      readJob: loadJob,
      transitionJob: transition,
      updateRoot,
      markPendingSlicesCancelled: cancelPending
    }
  });
}

/**
 * Crash-recovery / orphan continuation: when the orchestrator root is still running,
 * no slice is live, and either a ready pending slice exists or every slice completed,
 * start the next child or finalize the root.
 */
export async function continueJobChainOrchestration(input: {
  cwd: string;
  chain: JobChainRecord;
}, deps: AdvanceJobChainAfterChildDependencies = {}): Promise<AdvanceJobChainAfterChildResult> {
  const loadJob = deps.readJob ?? readJob;
  const loadChain = deps.readJobChain ?? readJobChain;
  const chain = loadChain(input.cwd, input.chain.chainId) ?? input.chain;
  const root = loadJob(input.cwd, chain.rootJobId);
  if (!root || !isChainOrchestratorRoot(root)) {
    return { root: root ?? ({ id: chain.rootJobId } as JobRecord), ignored: true };
  }

  const cancelPending = deps.markPendingSlicesCancelled ?? markPendingSlicesCancelled;
  if (!canContinueChainOrchestration(root)) {
    cancelPending(input.cwd, chain.chainId);
    return {
      root,
      rootTerminal: isTerminalJobStatus(root.status),
      ignored: true
    };
  }

  if (Object.values(chain.sliceStates).some((state) => state === "running")) {
    return { root, ignored: true };
  }

  return startNextReadySliceOrFinalizeRoot({
    cwd: input.cwd,
    root,
    chain,
    changedFiles: root.changedFiles,
    verification: root.verification,
    acceptance: root.acceptance,
    reportPaths: root.reportPaths ?? {},
    deps
  });
}

async function startNextReadySliceOrFinalizeRoot(input: {
  cwd: string;
  root: JobRecord;
  chain: JobChainRecord;
  changedFiles: string[];
  verification: JobVerification[];
  acceptance: JobAcceptanceSummary | undefined;
  reportPaths: JobReportPaths;
  deps: AdvanceJobChainAfterChildDependencies;
}): Promise<AdvanceJobChainAfterChildResult> {
  const { cwd, root, chain, changedFiles, verification, acceptance, reportPaths, deps } = input;
  const transition = deps.transitionJob ?? transitionJob;
  const updateRoot = deps.updateRoot ?? updateJobAuthoritative;
  const loadManifest = deps.readSliceManifest ?? readSliceManifestFromChain;
  const pickReady = deps.selectNextReadySlice ?? selectNextReadySlice;
  const cancelPending = deps.markPendingSlicesCancelled ?? markPendingSlicesCancelled;
  const loadJob = deps.readJob ?? readJob;

  const freshRoot = loadJob(cwd, root.id) ?? root;
  if (!canContinueChainOrchestration(freshRoot)) {
    cancelPending(cwd, chain.chainId);
    return {
      root: freshRoot,
      rootTerminal: isTerminalJobStatus(freshRoot.status),
      ignored: true
    };
  }

  const manifest = loadManifest(cwd, chain);
  if (!manifest) {
    const failed = await transition(cwd, root.id, {
      status: "failed",
      summary: "Slice chain manifest is missing after a completed child.",
      error: "Slice chain manifest is missing after a completed child.",
      errorCode: "slice_failed",
      changedFiles,
      verification,
      ...(acceptance ? { acceptance } : {}),
      reportPaths
    });
    return {
      root: failed.job,
      rootTerminal: true,
      deliveryCreated: failed.deliveryCreated
    };
  }

  const nextSlice = pickReady(manifest, chain);
  if (nextSlice) {
    const plan = resolveChainRootPlanInput(freshRoot) ?? resolveChainRootPlanInputFallback(freshRoot);
    if (!plan) {
      const failed = await transition(cwd, root.id, {
        status: "failed",
        summary: "Unable to rebuild slice child request for the next chain slice.",
        error: "Unable to rebuild slice child request for the next chain slice.",
        errorCode: "slice_failed",
        changedFiles,
        verification,
        ...(acceptance ? { acceptance } : {}),
        reportPaths
      });
      return {
        root: failed.job,
        rootTerminal: true,
        deliveryCreated: failed.deliveryCreated
      };
    }

    const createChild = deps.createChildJob ?? ((createCwd, createInput) => createJobStore(createCwd).create(createInput));
    const spawnSupervisor = deps.spawnJobSupervisor ?? spawnJobSupervisor;
    const markRunning = deps.markSliceRunning ?? markSliceRunning;

    const childRequest = buildSliceChildRequest(freshRoot, plan, nextSlice);
    const nextChild = createChild(cwd, {
      kind: freshRoot.kind,
      task: nextSlice.objective,
      request: childRequest,
      parentJobId: freshRoot.id,
      chainId: chain.chainId,
      sliceId: nextSlice.id
      // notificationTarget omitted — children must not notify
    });
    spawnSupervisor(cwd);
    markRunning(cwd, chain.chainId, nextSlice.id, nextChild.id);

    const sliceIndex = manifest.slices.findIndex((entry) => entry.id === nextSlice.id) + 1;
    const summary =
      `Executing slice ${sliceIndex}/${manifest.slices.length}: ${nextSlice.title}`;
    const updatedRoot = await updateRoot(cwd, root.id, {
      changedFiles,
      verification,
      ...(acceptance ? { acceptance } : {}),
      reportPaths,
      summary,
      phase: "editing"
    });

    return {
      root: updatedRoot,
      startedChildId: nextChild.id,
      rootTerminal: false,
      deliveryCreated: false
    };
  }

  if (Object.values(chain.sliceStates).some((state) => state === "pending")) {
    return { root: freshRoot, ignored: true };
  }

  const allCompleted = manifest.slices.every(
    (slice) => chain.sliceStates[slice.id] === "completed"
  );
  if (!allCompleted) {
    return { root: freshRoot, ignored: true };
  }

  const completed = await transition(cwd, root.id, {
    status: "completed",
    summary: `Completed ${chain.completedSliceIds.length} slice(s).`,
    changedFiles,
    verification,
    ...(acceptance ? { acceptance } : {}),
    reportPaths
  });

  return {
    root: completed.job,
    rootTerminal: true,
    deliveryCreated: completed.deliveryCreated
  };
}

function canContinueChainOrchestration(root: JobRecord): boolean {
  return root.status === "running" && !root.cancellationRequestedAt;
}

function isTerminalJobStatus(status: JobStatus): boolean {
  return status !== "queued" && status !== "running";
}

function mergeAcceptanceSummaries(
  root: JobAcceptanceSummary | undefined,
  child: JobAcceptanceSummary | undefined
): JobAcceptanceSummary | undefined {
  if (!root && !child) return undefined;
  if (!root) return child;
  if (!child) return root;
  return {
    stages: [...root.stages, ...child.stages],
    ...(child.failedStage !== undefined
      ? { failedStage: child.failedStage }
      : root.failedStage !== undefined
        ? { failedStage: root.failedStage }
        : {}),
    ...(child.failedCommand !== undefined
      ? { failedCommand: child.failedCommand }
      : root.failedCommand !== undefined
        ? { failedCommand: root.failedCommand }
        : {}),
    ...(child.failedTests !== undefined
      ? { failedTests: child.failedTests }
      : root.failedTests !== undefined
        ? { failedTests: root.failedTests }
        : {}),
    ...(child.suggestion !== undefined
      ? { suggestion: child.suggestion }
      : root.suggestion !== undefined
        ? { suggestion: root.suggestion }
        : {})
  };
}

function buildRootAttentionTransition(input: {
  child: JobRecord;
  sliceState: Exclude<SliceRuntimeState, "pending" | "running">;
  changedFiles: string[];
  verification: JobVerification[];
  acceptance: JobAcceptanceSummary | undefined;
  reportPaths: JobReportPaths;
}): JobTransition {
  const sliceLabel = input.child.sliceId ?? "slice";
  const base = {
    changedFiles: input.changedFiles,
    verification: input.verification,
    ...(input.acceptance ? { acceptance: input.acceptance } : {}),
    reportPaths: input.reportPaths
  };

  if (input.sliceState === "failed") {
    const failureCauses = childFailureCauses(input.child);
    if (!isResumableSliceFailure(input.child)) {
      return {
        ...base,
        status: "failed",
        summary: input.child.summary ?? `Slice ${sliceLabel} failed.`,
        error: input.child.error ?? input.child.summary ?? `Slice ${sliceLabel} failed.`,
        ...(input.child.errorCode ? { errorCode: input.child.errorCode } : {}),
        ...(input.child.sessionId !== undefined ? { sessionId: input.child.sessionId } : {}),
        ...(failureCauses ? { failureCauses } : {})
      };
    }
    return {
      ...base,
      status: "failed",
      summary: `Slice ${sliceLabel} failed.`,
      error: input.child.error ?? `Slice ${sliceLabel} failed.`,
      errorCode: "slice_failed",
      ...(failureCauses ? { failureCauses } : {})
    };
  }

  if (input.sliceState === "stalled") {
    return {
      ...base,
      status: "stalled",
      summary: input.child.summary ?? `Slice ${sliceLabel} stalled.`,
      error: input.child.error ?? input.child.summary ?? `Slice ${sliceLabel} stalled.`,
      ...(input.child.errorCode ? { errorCode: input.child.errorCode } : {})
    };
  }

  if (input.sliceState === "needs_input") {
    return {
      ...base,
      status: "needs_input",
      summary: input.child.summary ?? `Slice ${sliceLabel} needs input.`,
      ...(input.child.error ? { error: input.child.error } : {}),
      ...(input.child.errorCode ? { errorCode: input.child.errorCode } : {})
    };
  }

  if (input.sliceState === "blocked") {
    return {
      ...base,
      status: "blocked",
      summary: input.child.summary ?? `Slice ${sliceLabel} is blocked.`,
      error: input.child.error ?? input.child.summary ?? `Slice ${sliceLabel} is blocked.`,
      ...(input.child.errorCode ? { errorCode: input.child.errorCode } : {})
    };
  }

  if (input.sliceState === "timeout") {
    return {
      ...base,
      status: "timeout",
      summary: input.child.summary ?? `Slice ${sliceLabel} timed out.`,
      error: input.child.error ?? input.child.summary ?? `Slice ${sliceLabel} timed out.`,
      ...(input.child.errorCode ? { errorCode: input.child.errorCode } : { errorCode: "timeout" })
    };
  }

  return {
    ...base,
    status: "cancelled",
    summary: input.child.summary ?? `Slice ${sliceLabel} was cancelled.`,
    ...(input.child.errorCode ? { errorCode: input.child.errorCode } : { errorCode: "cancelled" })
  };
}

function childFailureCauses(child: JobRecord): JobFailureCause[] | undefined {
  const causes: JobFailureCause[] = [];
  if (child.errorCode) {
    const matchingCause = child.failureCauses?.find(
      (cause) => cause.code === child.errorCode
    );
    causes.push({
      code: child.errorCode,
      stage: matchingCause?.stage ??
        child.acceptance?.failedStage ??
        childFailureStage(child.errorCode),
      ...(child.acceptance?.failedCommand
        ? { command: child.acceptance.failedCommand }
        : {}),
      ...(child.acceptance?.suggestion
        ? { suggestion: child.acceptance.suggestion }
        : {})
    });
  }
  for (const cause of child.failureCauses ?? []) {
    if (!causes.some((candidate) =>
      candidate.code === cause.code &&
      candidate.stage === cause.stage &&
      candidate.command === cause.command
    )) {
      causes.push(cause);
    }
  }
  return causes.length > 0 ? causes : undefined;
}

function childFailureStage(errorCode: string): JobFailureCause["stage"] {
  if (errorCode === "build_failed" || errorCode === "acceptance_command_unavailable") {
    return "build";
  }
  if (errorCode === "tests_failed") return "test";
  if (errorCode === "write_scope_violation") return "scope_check";
  if (errorCode === "diff_check_failed" || errorCode === "delivery_contract_missing") {
    return "diff_check";
  }
  if (errorCode === "prompt_identity_mismatch") return "prompt";
  if (errorCode.startsWith("callback_")) return "callback";
  return "execution";
}

function isResumableSliceFailure(child: JobRecord): boolean {
  return child.errorCode !== undefined && RESUMABLE_FAILURE_CODES.has(child.errorCode);
}

async function refreshRootChainCheckpoint(input: {
  cwd: string;
  root: JobRecord;
  chain: JobChainRecord;
  changedFiles: string[];
}): Promise<void> {
  try {
    const reportDir = path.join(input.cwd, ".codex-mimo", "reports");
    const checkpointPath = input.root.reportPaths?.checkpoint
      ?? path.join(reportDir, `${input.root.id}.checkpoint.json`);
    const existing = readJobCheckpoint(checkpointPath);
    if (existing) {
      const next = {
        ...existing,
        chainId: input.chain.chainId,
        changedFiles: input.changedFiles,
        completedSlices: [...input.chain.completedSliceIds],
        acceptance: input.root.acceptance ?? existing.acceptance,
        artifactPaths: {
          ...existing.artifactPaths,
          ...(input.root.reportPaths ?? {})
        }
      };
      fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
      const temporary =
        `${checkpointPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(next, null, 2), "utf8");
        renameWithWindowsRetry(temporary, checkpointPath);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      return;
    }

    await writeJobCheckpoint({
      job: {
        ...input.root,
        chainId: input.chain.chainId,
        changedFiles: input.changedFiles
      },
      objective: input.root.task,
      changedFiles: input.changedFiles,
      acceptance: input.root.acceptance,
      existingReportPaths: input.root.reportPaths,
      completedSlices: [...input.chain.completedSliceIds]
    });
  } catch {
    // Root checkpoint refresh is best-effort; chain/job records remain authoritative.
  }
}

function resolveChainRootPlanInputFallback(job: JobRecord): {
  objective: string;
  batchMode: BatchMode;
  acceptance?: DevelopmentAcceptanceInput;
  legacyVerification?: string[];
  allowedPaths?: string[];
  workflow?: ComposeWorkflowName;
  file?: string;
  since?: string;
  reportDir?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  progressWarningMs?: number;
  progressTimeoutMs?: number;
} | null {
  if (typeof job.request !== "object" || job.request === null) return null;
  const request = job.request as Record<string, unknown>;
  return {
    objective: job.task,
    batchMode: "single",
    ...(typeof request.timeoutMs === "number" ? { timeoutMs: request.timeoutMs } : {}),
    ...(typeof request.idleTimeoutMs === "number" ? { idleTimeoutMs: request.idleTimeoutMs } : {}),
    ...(typeof request.progressWarningMs === "number"
      ? { progressWarningMs: request.progressWarningMs }
      : {}),
    ...(typeof request.progressTimeoutMs === "number"
      ? { progressTimeoutMs: request.progressTimeoutMs }
      : {}),
    ...(typeof request.workflow === "string"
      ? { workflow: request.workflow as ComposeWorkflowName }
      : {}),
    ...(typeof request.file === "string" ? { file: request.file } : {}),
    ...(typeof request.since === "string" ? { since: request.since } : {}),
    ...(typeof request.reportDir === "string" ? { reportDir: request.reportDir } : {}),
    ...(Array.isArray(request.verification) &&
        request.verification.every((entry) => typeof entry === "string")
      ? { legacyVerification: request.verification as string[] }
      : {}),
    ...(Array.isArray(request.allowedPaths) &&
        request.allowedPaths.every((entry) => typeof entry === "string")
      ? { allowedPaths: request.allowedPaths as string[] }
      : {}),
    ...(request.acceptance && typeof request.acceptance === "object"
      ? { acceptance: request.acceptance as DevelopmentAcceptanceInput }
      : {})
  };
}

function resolveChainRootPlanInput(job: JobRecord): {
  objective: string;
  batchMode: BatchMode;
  acceptance?: DevelopmentAcceptanceInput;
  legacyVerification?: string[];
  allowedPaths?: string[];
  workflow?: ComposeWorkflowName;
  file?: string;
  since?: string;
  reportDir?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  progressWarningMs?: number;
  progressTimeoutMs?: number;
} | null {
  if (job.kind === "implement") {
    const parsed = ImplementRequestSchema.safeParse(job.request);
    if (!parsed.success || !isBootstrapBatchMode(parsed.data.batchMode)) return null;
    return {
      objective: parsed.data.task,
      batchMode: parsed.data.batchMode,
      acceptance: parsed.data.acceptance,
      ...(parsed.data.allowedPaths ? { allowedPaths: parsed.data.allowedPaths } : {}),
      timeoutMs: parsed.data.timeoutMs,
      idleTimeoutMs: parsed.data.idleTimeoutMs,
      progressWarningMs: parsed.data.progressWarningMs,
      progressTimeoutMs: parsed.data.progressTimeoutMs
    };
  }
  if (job.kind === "compose") {
    const parsed = ComposeRequestSchema.safeParse(job.request);
    if (!parsed.success || !isBootstrapBatchMode(parsed.data.batchMode)) return null;
    const workflow = getComposeWorkflow(parsed.data.workflow);
    if (!workflow.writesAllowed) return null;
    return {
      objective: parsed.data.task?.trim() || job.task,
      batchMode: parsed.data.batchMode ?? "auto",
      acceptance: parsed.data.acceptance,
      legacyVerification: parsed.data.verification,
      ...(parsed.data.allowedPaths ? { allowedPaths: parsed.data.allowedPaths } : {}),
      workflow: parsed.data.workflow,
      ...(parsed.data.file ? { file: parsed.data.file } : {}),
      ...(parsed.data.since ? { since: parsed.data.since } : {}),
      ...(parsed.data.reportDir ? { reportDir: parsed.data.reportDir } : {}),
      timeoutMs: parsed.data.timeoutMs,
      idleTimeoutMs: parsed.data.idleTimeoutMs,
      progressWarningMs: parsed.data.progressWarningMs,
      progressTimeoutMs: parsed.data.progressTimeoutMs
    };
  }
  return null;
}

function buildSliceChildRequest(
  root: JobRecord,
  plan: NonNullable<ReturnType<typeof resolveChainRootPlanInput>>,
  slice: SliceDefinition
): unknown {
  const common = {
    cwd: root.cwd,
    ...(plan.timeoutMs !== undefined ? { timeoutMs: plan.timeoutMs } : {}),
    ...(plan.idleTimeoutMs !== undefined ? { idleTimeoutMs: plan.idleTimeoutMs } : {}),
    ...(plan.progressWarningMs !== undefined ? { progressWarningMs: plan.progressWarningMs } : {}),
    ...(plan.progressTimeoutMs !== undefined ? { progressTimeoutMs: plan.progressTimeoutMs } : {}),
    acceptance: slice.acceptance,
    allowedPaths: slice.allowedPaths,
    ...(plan.legacyVerification ? { verification: plan.legacyVerification } : {}),
    ...(plan.file ? { file: plan.file } : {}),
    ...(plan.since ? { since: plan.since } : {}),
    ...(plan.reportDir ? { reportDir: plan.reportDir } : {}),
    // Prevent nested chain bootstrap on children.
    batchMode: "single" as const
  };

  if (root.kind === "implement") {
    return {
      ...common,
      task: slice.objective,
      allowWrite: true as const
    };
  }

  return {
    ...common,
    workflow: plan.workflow,
    task: slice.objective
  };
}

export { isChainOrchestratorRoot };
