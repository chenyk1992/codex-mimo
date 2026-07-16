import path from "node:path";
import { z } from "zod";
import {
  createComposeReport,
  writeComposeReport,
  type ComposeReport
} from "../compose/report.js";
import {
  buildReadOnlyReportDiff,
  detectNewFilesFromStatus,
  detectReadOnlyViolationFiles,
  gitHeadChanged,
  mergeChangedFiles,
  readOnlyViolationError
} from "../compose/post-checks.js";
import {
  compactVerification,
  normalizeVerificationCommands,
  runVerificationCommands,
  type VerificationResult
} from "../compose/verify.js";
import {
  buildComposePrompt,
  COMPOSE_WORKFLOW_NAMES,
  getComposeWorkflow,
  type ComposeWorkflowName
} from "../compose/workflow.js";
import { extractFinalText, type NormalizedMimoEvent } from "../compose/events.js";
import {
  captureGitDiff,
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
import { implementPrompt, planPrompt, reviewPrompt } from "./prompt.js";
import { classifyRunOutcome, type JobOutcome } from "./job-outcome.js";
import type { ExecutionCallbackSummary, JobKind, JobRecord } from "./jobs.js";

const DEFAULT_TIMEOUT_MS = 1_800_000;

const CommonRequestSchema = z.object({
  cwd: z.string().min(1),
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS)
}).strict();

const PlanRequestSchema = CommonRequestSchema.extend({
  task: z.string().min(1)
});

const ImplementRequestSchema = CommonRequestSchema.extend({
  task: z.string().min(1),
  allowWrite: z.literal(true)
});

const ReviewRequestSchema = CommonRequestSchema.extend({
  base: z.string().min(1).default("HEAD")
});

const FixCiRequestSchema = CommonRequestSchema.extend({
  file: z.string().min(1),
  task: z.string().min(1).optional()
});

const ResumeRequestSchema = CommonRequestSchema.extend({
  jobId: z.string().min(1),
  task: z.string().min(1),
  sessionId: z.string().min(1)
});

const ComposeRequestSchema = CommonRequestSchema.extend({
  workflow: z.enum(COMPOSE_WORKFLOW_NAMES),
  task: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  since: z.string().min(1).optional(),
  verification: z.array(z.string().min(1)).optional(),
  reportDir: z.string().min(1).optional()
}).superRefine((request, context) => {
  const workflow = getComposeWorkflow(request.workflow);
  if (workflow.requiresTask && !request.task?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `Workflow ${request.workflow} requires a task.` });
  }
  if (workflow.requiresFile && !request.file?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `Workflow ${request.workflow} requires --file.` });
  }
});

export type PlanJobRequest = z.input<typeof PlanRequestSchema>;
export type ImplementJobRequest = z.input<typeof ImplementRequestSchema>;
export type ReviewJobRequest = z.input<typeof ReviewRequestSchema>;
export type FixCiJobRequest = z.input<typeof FixCiRequestSchema>;
export type ResumeJobRequest = z.input<typeof ResumeRequestSchema>;
export type ComposeJobRequest = z.input<typeof ComposeRequestSchema>;

export interface JobRequestByKind {
  plan: PlanJobRequest;
  implement: ImplementJobRequest;
  review: ReviewJobRequest;
  "fix-ci": FixCiJobRequest;
  resume: ResumeJobRequest;
  compose: ComposeJobRequest;
}

export interface JobFinalizeDependencies {
  runVerification?: (cwd: string, commands: string[]) => Promise<VerificationResult[]>;
  writeComposeReport?: (report: ComposeReport) => void;
}

export interface JobExecutionFinalizeContext {
  mimoArgs?: string[];
  run: StreamingRunResult;
  events: NormalizedMimoEvent[];
  executionCallback?: ExecutionCallbackSummary;
  gitStatusBefore?: GitStatusSnapshot;
  gitStatusAfter?: GitStatusSnapshot;
  gitHeadBefore?: GitHeadSnapshot;
  gitHeadAfter?: GitHeadSnapshot;
  diff?: GitDiffSnapshot;
  commitChanges?: GitCommitChangeSnapshot;
  verification?: VerificationResult[];
  deps?: JobFinalizeDependencies;
}

export interface JobFinalizeContext<Request extends { cwd: string }> extends JobExecutionFinalizeContext {
  job: JobRecord;
  request: Request;
}

export interface JobDefinition<Kind extends JobKind, Request extends { cwd: string }> {
  kind: Kind;
  writesAllowed: boolean;
  buildPrompt(request: Request): Promise<PromptTransportResult>;
  buildMimoArgs(request: Request, prompt: PromptTransportResult): string[];
  finalize(context: JobFinalizeContext<Request>): Promise<JobOutcome>;
}

export type JobDefinitionRegistry = {
  [Kind in JobKind]: JobDefinition<Kind, JobRequestByKind[Kind]>;
};

export interface BoundJobDefinition {
  kind: JobKind;
  writesAllowed: boolean;
  buildPrompt(): Promise<PromptTransportResult>;
  buildMimoArgs(prompt: PromptTransportResult): string[];
  finalize(context: JobExecutionFinalizeContext): Promise<JobOutcome>;
}

const planDefinition: JobDefinition<"plan", PlanJobRequest> = directDefinition({
  kind: "plan",
  agent: "plan",
  writesAllowed: false,
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
  writesAllowed: false,
  async buildPrompt(request) {
    const base = request.base ?? "HEAD";
    const diff = await captureGitDiff(request.cwd, base);
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
      agent: "plan",
      model: request.model,
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
  prompt: (request) => implementPrompt(request.task ?? "Fix the CI failures shown in the attached log."),
  files: (request) => [request.file],
  title: "codex-mimo fix-ci"
});

const resumeDefinition: JobDefinition<"resume", ResumeJobRequest> = directDefinition({
  kind: "resume",
  agent: "build",
  writesAllowed: true,
  prompt: (request) => implementPrompt(request.task),
  session: (request) => request.sessionId,
  title: "codex-mimo resume"
});

const composeDefinition: JobDefinition<"compose", ComposeJobRequest> = {
  kind: "compose",
  writesAllowed: true,
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
    return buildMimoRunArgs({
      cwd: request.cwd,
      agent: "compose",
      model: request.model,
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
    writesAllowed: definition.writesAllowed,
    buildPrompt: () => definition.buildPrompt(request),
    buildMimoArgs: (prompt) => definition.buildMimoArgs(request, prompt),
    finalize: (context) => definition.finalize({ ...context, job, request })
  };
}

interface DirectDefinitionInput<Kind extends Exclude<JobKind, "compose">, Request extends { cwd: string; model?: string }> {
  kind: Kind;
  agent: "plan" | "build";
  writesAllowed: boolean;
  prompt: (request: Request) => string;
  files?: (request: Request) => string[];
  session?: (request: Request) => string;
  title: string;
}

function directDefinition<Kind extends Exclude<JobKind, "compose">, Request extends { cwd: string; model?: string }>(
  input: DirectDefinitionInput<Kind, Request>
): JobDefinition<Kind, Request> {
  return {
    kind: input.kind,
    writesAllowed: input.writesAllowed,
    async buildPrompt(request) {
      return preparePromptTransport(input.prompt(request), { cwd: request.cwd });
    },
    buildMimoArgs(request, prompt) {
      return buildMimoRunArgs({
        cwd: request.cwd,
        agent: input.agent,
        model: request.model,
        session: input.session?.(request),
        message: prompt.message,
        title: input.title,
        files: mergeChangedFiles(prompt.files, input.files?.(request) ?? [])
      });
    },
    async finalize(context) {
      return finalizeDirect(context, input.writesAllowed);
    }
  };
}

async function finalizeDirect<Request extends { cwd: string }>(
  context: JobFinalizeContext<Request>,
  writesAllowed: boolean
): Promise<JobOutcome> {
  const verification = context.verification ?? [];
  const changedFiles = collectChangedFiles(context, writesAllowed);
  const outcome = classifyRunOutcome({
    exitCode: context.run.exitCode,
    terminationReason: context.run.terminationReason,
    executionCallback: context.executionCallback,
    verification: compactVerification(verification),
    finalText: finalTextFrom(context)
  });

  if (!writesAllowed && hasReadOnlyViolation(context, changedFiles)) {
    const error = readOnlyViolationError(
      context.job.kind,
      changedFiles,
      context.gitHeadBefore,
      context.gitHeadAfter
    );
    if (!outcome.errorCode?.startsWith("callback_")) {
      return {
        ...outcome,
        status: "failed",
        summary: error,
        changedFiles,
        error,
        errorCode: "read_only_violation"
      };
    }
  }

  return { ...outcome, changedFiles };
}

async function finalizeCompose(context: JobFinalizeContext<ComposeJobRequest>): Promise<JobOutcome> {
  const workflow = getComposeWorkflow(context.request.workflow);
  const runVerification = context.deps?.runVerification ?? runVerificationCommands;
  const commands = normalizeVerificationCommands(
    context.request.verification,
    workflow.defaultVerification,
    context.request.cwd
  );
  const verification = await runVerification(context.request.cwd, commands);

  const changedFiles = collectChangedFiles(context, workflow.writesAllowed);
  let reportDiff = context.diff ?? emptyDiff();
  if (!workflow.writesAllowed) {
    reportDiff = buildReadOnlyReportDiff(reportDiff, changedFiles);
  } else if (changedFiles.length > 0) {
    reportDiff = { ...reportDiff, changedFiles };
  }

  let outcome = classifyRunOutcome({
    exitCode: context.run.exitCode,
    terminationReason: context.run.terminationReason,
    executionCallback: context.executionCallback,
    verification: compactVerification(verification),
    finalText: finalTextFrom(context)
  });

  const readOnlyError = !workflow.writesAllowed && hasReadOnlyViolation(context, changedFiles)
    ? readOnlyViolationError(
      workflow.name,
      changedFiles,
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

  const report = createComposeReport({
    id: context.job.id,
    createdAt: context.job.createdAt,
    workflow: workflow.name,
    cwd: context.request.cwd,
    task: context.request.task ?? defaultComposeTask(workflow.name),
    mimoArgs: context.mimoArgs ?? [],
    requestedSkills: workflow.skillChain,
    status: composeReportStatus(outcome, verification, changedFiles),
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
    verification,
    error: outcome.error,
    reportDir: context.request.reportDir ?? path.join(context.request.cwd, ".codex-mimo", "reports"),
    eventsDir: path.join(context.request.cwd, ".codex-mimo", "events"),
    diffsDir: path.join(context.request.cwd, ".codex-mimo", "diffs")
  });
  (context.deps?.writeComposeReport ?? writeComposeReport)(report);

  return {
    ...outcome,
    changedFiles,
    verification: compactVerification(verification),
    reportPaths: {
      json: report.reportPaths.json,
      markdown: report.reportPaths.markdown,
      eventsJsonl: report.reportPaths.eventsJsonl,
      ...(report.diffPath ? { diff: report.diffPath } : {})
    }
  };
}

function collectChangedFiles(
  context: JobExecutionFinalizeContext,
  writesAllowed: boolean
): string[] {
  const diffFiles = context.diff?.changedFiles ?? [];
  const commitFiles = context.commitChanges?.changedFiles ?? [];
  if (!writesAllowed) {
    const statusFiles = detectReadOnlyViolationFiles(
      false,
      diffFiles,
      context.gitStatusBefore,
      context.gitStatusAfter
    );
    return mergeChangedFiles(statusFiles, commitFiles);
  }
  const newStatusFiles = context.gitStatusBefore && context.gitStatusAfter
    ? detectNewFilesFromStatus(context.gitStatusBefore, context.gitStatusAfter)
    : [];
  return mergeChangedFiles(diffFiles, commitFiles, newStatusFiles);
}

function hasReadOnlyViolation(context: JobExecutionFinalizeContext, changedFiles: string[]): boolean {
  return changedFiles.length > 0 || gitHeadChanged(context.gitHeadBefore, context.gitHeadAfter);
}

function finalTextFrom(context: JobExecutionFinalizeContext): string {
  return context.executionCallback?.finalText?.trim() || extractFinalText(context.events);
}

function emptyDiff(): GitDiffSnapshot {
  return { changedFiles: [], diffStat: "", diff: "" };
}

function composeReportStatus(
  outcome: JobOutcome,
  verification: VerificationResult[],
  changedFiles: string[]
): ComposeReport["status"] {
  if (outcome.status === "timeout") return "timeout";
  if (outcome.status !== "completed") return "failed";
  if (verification.length === 0 && changedFiles.length > 0) return "needs_review";
  return "passed";
}

function defaultComposeTask(workflow: ComposeWorkflowName): string {
  return `Run ${workflow} workflow.`;
}
