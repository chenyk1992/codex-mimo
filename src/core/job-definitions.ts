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
  type VerificationResult,
  type VerificationRunOptions
} from "../compose/verify.js";
import {
  buildComposePrompt,
  getComposeWorkflow
} from "../compose/workflow.js";
import { extractFinalText, collectChangedFilesFromEvents, type NormalizedMimoEvent } from "../compose/events.js";
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
import { implementPrompt, planPrompt, resumePrompt, reviewPrompt } from "./prompt.js";
import { classifyRunOutcome, type JobOutcome } from "./job-outcome.js";
import type { ExecutionCallbackSummary, JobKind, JobRecord } from "./jobs.js";
import {
  ComposeRequestSchema,
  FixCiRequestSchema,
  ImplementRequestSchema,
  JobExecutionPolicySchema,
  PlanRequestSchema,
  ResumeRequestSchema,
  ReviewRequestSchema
} from "./job-schemas.js";

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
  writeComposeReport?: (report: ComposeReport) => void;
}

export interface JobExecutionFinalizeContext {
  signal: AbortSignal;
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
  agent: "plan",
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
  executionPolicy: () => ({ agent: "plan", writesAllowed: false }),
  async buildPrompt(request, signal) {
    const base = request.base ?? "HEAD";
    const diff = await captureGitDiff(request.cwd, base, { signal });
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

const resumeDefinition: JobDefinition<"resume", ResumeJobRequest> = {
  kind: "resume",
  executionPolicy: (request) => ({ ...request.executionPolicy }),
  async buildPrompt(request) {
    return preparePromptTransport(
      resumePrompt(request.task, request.executionPolicy.writesAllowed),
      { cwd: request.cwd }
    );
  },
  buildMimoArgs(request, prompt) {
    return buildMimoRunArgs({
      cwd: request.cwd,
      agent: request.executionPolicy.agent,
      model: request.model,
      session: request.sessionId,
      message: prompt.message,
      title: "codex-mimo resume",
      files: prompt.files
    });
  },
  async finalize(context) {
    return finalizeDirect(context, context.request.executionPolicy.writesAllowed);
  }
};

const composeDefinition: JobDefinition<"compose", ComposeJobRequest> = {
  kind: "compose",
  executionPolicy: (request) => ({
    agent: "compose",
    writesAllowed: getComposeWorkflow(request.workflow).writesAllowed
  }),
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

export function bindJobDefinition(job: JobRecord): BoundJobDefinition {
  switch (job.kind) {
    case "plan":
      return bind(job, PlanRequestSchema, planDefinition);
    case "implement":
      return bind(job, ImplementRequestSchema, implementDefinition);
    case "review":
      return bind(job, ReviewRequestSchema, reviewDefinition);
    case "fix-ci":
      return bind(job, FixCiRequestSchema, fixCiDefinition);
    case "resume":
      return bind(job, ResumeRequestSchema, resumeDefinition);
    case "compose":
      return bind(job, ComposeRequestSchema, composeDefinition);
  }
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
  Request extends { cwd: string; model?: string }
> {
  kind: Kind;
  agent: "plan" | "build";
  writesAllowed: boolean;
  requireFinalText?: boolean;
  prompt: (request: Request) => string;
  files?: (request: Request) => string[];
  title: string;
}

function directDefinition<
  Kind extends Exclude<JobKind, "compose" | "resume">,
  Request extends { cwd: string; model?: string }
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
        model: request.model,
        message: prompt.message,
        title: input.title,
        files: mergeChangedFiles(prompt.files, input.files?.(request) ?? [])
      });
    },
    async finalize(context) {
      return finalizeDirect(context, input.writesAllowed, input.requireFinalText === true);
    }
  };
}

async function finalizeDirect<Request extends { cwd: string }>(
  context: JobFinalizeContext<Request>,
  writesAllowed: boolean,
  requireFinalText = false
): Promise<JobOutcome> {
  const verification = context.verification ?? [];
  const changedFiles = collectChangedFiles(context, writesAllowed);
  const outcome = applyReadOnlyViolation(
    classifyRunOutcome({
      exitCode: context.run.exitCode,
      terminationReason: context.run.terminationReason,
      executionCallback: context.executionCallback,
      verification: compactVerification(verification),
      finalText: finalTextFrom(context),
      ...(requireFinalText ? { requireFinalText: true } : {})
    }),
    context,
    writesAllowed,
    changedFiles,
    context.job.kind
  );

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
  context.signal.throwIfAborted();
  const verification = await runVerification(context.request.cwd, commands, { signal: context.signal });
  context.signal.throwIfAborted();

  const changedFiles = collectChangedFiles(context, workflow.writesAllowed);
  let reportDiff = context.diff ?? emptyDiff();
  if (!workflow.writesAllowed) {
    reportDiff = buildReadOnlyReportDiff(reportDiff, changedFiles);
  } else if (changedFiles.length > 0) {
    reportDiff = { ...reportDiff, changedFiles };
  }

  const outcome = applyReadOnlyViolation(
    classifyRunOutcome({
      exitCode: context.run.exitCode,
      terminationReason: context.run.terminationReason,
      executionCallback: context.executionCallback,
      verification: compactVerification(verification),
      finalText: finalTextFrom(context),
      ...(workflow.name === "plan" ? { requireFinalText: true } : {})
    }),
    context,
    workflow.writesAllowed,
    changedFiles,
    workflow.name
  );

  const report = createComposeReport({
    id: context.job.id,
    createdAt: context.job.createdAt,
    workflow: workflow.name,
    cwd: context.request.cwd,
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
    errorCode: outcome.errorCode,
    reportDir: context.request.reportDir ?? path.join(context.request.cwd, ".codex-mimo", "reports"),
    eventsDir: path.join(context.request.cwd, ".codex-mimo", "events"),
    diffsDir: path.join(context.request.cwd, ".codex-mimo", "diffs")
  });
  context.signal.throwIfAborted();
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
  const eventFiles = collectChangedFilesFromEvents(context.events);
  if (!writesAllowed) {
    const statusFiles = detectReadOnlyViolationFiles(
      false,
      diffFiles,
      context.gitStatusBefore,
      context.gitStatusAfter
    );
    return mergeChangedFiles(statusFiles, commitFiles, eventFiles);
  }
  const newStatusFiles = context.gitStatusBefore && context.gitStatusAfter
    ? detectNewFilesFromStatus(context.gitStatusBefore, context.gitStatusAfter)
    : [];
  return mergeChangedFiles(diffFiles, commitFiles, newStatusFiles, eventFiles);
}

function applyReadOnlyViolation(
  outcome: JobOutcome,
  context: JobExecutionFinalizeContext,
  writesAllowed: boolean,
  changedFiles: string[],
  label: string
): JobOutcome {
  if (writesAllowed || !hasReadOnlyViolation(context, changedFiles)) return outcome;
  if (outcome.errorCode?.startsWith("callback_")) return outcome;
  const error = readOnlyViolationError(
    label,
    changedFiles,
    context.gitHeadBefore,
    context.gitHeadAfter
  );
  return {
    ...outcome,
    status: "failed",
    summary: error,
    error,
    errorCode: "read_only_violation"
  };
}

function hasReadOnlyViolation(context: JobExecutionFinalizeContext, changedFiles: string[]): boolean {
  return changedFiles.length > 0 || gitHeadChanged(context.gitHeadBefore, context.gitHeadAfter);
}

function finalTextFrom(context: JobExecutionFinalizeContext): string {
  return extractFinalText(context.events);
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
