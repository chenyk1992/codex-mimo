import type { JobCheckpoint } from "./job-checkpoint.js";

export function planPrompt(task: string): string {
  return [
    "Objective:",
    task,
    "",
    "Execute this objective now. Do not ask what the task is; the Objective above is the task.",
    "",
    "You are being invoked by Codex as a specialist MiMoCode planning agent.",
    "",
    "Rules:",
    "- Do not edit files.",
    "- Inspect only the code needed for this task.",
    "- Produce a concise implementation plan using these sections: Conclusions, Evidence, Assumptions and Unknowns, Ordered Implementation Steps, Executable Acceptance.",
    "- Tie conclusions to repository files, interfaces, tests, or command output inspected during this run.",
    "- Do not claim behavior is existing, safe, or idempotent without repository evidence; label unsupported inferences as assumptions.",
    "- Include touched files, risks, and directly executable verification commands.",
    "- Prefer the smallest change that satisfies the request.",
    "- If the task is ambiguous, state assumptions instead of broadening scope."
  ].join("\n");
}

export function implementPrompt(task: string): string {
  return [
    "Objective:",
    task,
    "",
    "Execute this objective now. Do not ask what the task is; the Objective above is the task.",
    "",
    "You are being invoked by Codex as a specialist MiMoCode implementation agent.",
    "",
    "Rules:",
    "- Keep changes surgical.",
    "- Do not modify unrelated files.",
    "- Do not commit, push, reset, or delete files.",
    "- Run the narrowest meaningful verification when practical.",
    "- Return changed files, commands run, results, and remaining risks."
  ].join("\n");
}

export function reviewPrompt(diffSummary: string): string {
  return [
    "Objective:",
    `Review the following diff for correctness, regressions, security issues, and missing test coverage.\n\n${diffSummary}`,
    "",
    "Execute this objective now. Do not ask what the task is; the Objective above is the task.",
    "",
    "You are being invoked by Codex as a specialist MiMoCode review agent.",
    "",
    "Rules:",
    "- Do not edit files.",
    "- Prioritize correctness bugs, regressions, security, and missing tests.",
    "- Give file and line references when available.",
    "- If no issues are found, say that clearly and mention residual risk."
  ].join("\n");
}

export function slicePlanningPrompt(
  objective: string,
  context?: {
    chainId: string;
    repositoryFingerprint: string;
    acceptance: {
      build?: string[];
      test?: string[];
      diffCheck?: boolean;
    };
  }
): string {
  const example = JSON.stringify(
    {
      version: 1,
      chainId: context?.chainId ?? "chain-example",
      objective,
      repositoryFingerprint: context?.repositoryFingerprint ?? "fp-example",
      slices: [
        {
          id: "slice-1",
          title: "Add schema module",
          objective: "Add only the schema module",
          dependsOn: [],
          contextFiles: ["src/schema.ts"],
          allowedPaths: ["src/schema.ts"],
          acceptance: context?.acceptance ?? {
            build: ["npm run build"],
            test: ["npm test -- schema.test.ts"]
          }
        }
      ]
    },
    null,
    2
  );
  return [
    "Objective:",
    objective,
    "",
    "Execute this objective now. Do not ask what the task is; the Objective above is the task.",
    "",
    "You are being invoked by Codex-MiMo as a read-only slice planning agent.",
    "",
    "Rules:",
    "- Do not edit files.",
    "- Do not run commands that modify the workspace.",
    "- Decompose the objective into one to eight bounded, sequential slices.",
    "- Each slice must have one explicit deliverable with bounded allowedPaths.",
    "- allowedPaths patterns must be repository-relative and use only: exact files (src/app.ts), directories (src/components), or trailing /** (src/components/**).",
    "- Do not use repository-wide \"**\", bare globs, absolute paths, or \"..\" traversal in allowedPaths.",
    "- Each slice must include acceptance with build disposition and targeted test commands.",
    ...(context
      ? [
          `- Use the exact chainId ${JSON.stringify(context.chainId)} and repositoryFingerprint ${JSON.stringify(context.repositoryFingerprint)}.`,
          `- Use these caller-supplied acceptance defaults when a slice has no narrower command: ${JSON.stringify(context.acceptance)}.`
        ]
      : []),
    "- Prefer narrow slices such as \"only add the schema\" rather than grouping an entire feature.",
    "- Your final message must include one JSON SliceManifest envelope.",
    "",
    "Required final JSON envelope:",
    "```json",
    example,
    "```"
  ].join("\n");
}

export function diffReviewPrompt(diffPath: string): string {
  const example = JSON.stringify({ verdict: "pass", findings: [] }, null, 2);
  return [
    "Objective:",
    `Review the implementation diff attached as @${diffPath} for correctness, regressions, security issues, and missing test coverage.`,
    "",
    "Execute this objective now. Do not ask what the task is; the Objective above is the task.",
    "",
    "You are being invoked by Codex-MiMo as a read-only diff review agent for development acceptance.",
    "",
    "Rules:",
    "- Do not edit files.",
    "- Do not run commands that modify the workspace.",
    "- Prioritize correctness bugs, regressions, security, and missing tests.",
    "- Give file and line references when available.",
    "- Your final message must include one JSON verdict envelope.",
    "",
    "Required final JSON envelope:",
    "```json",
    example,
    "```",
    "",
    "Finding severities: blocker, major, minor, info.",
    "Use verdict \"fail\" when any blocker or major finding exists."
  ].join("\n");
}

export function resumePrompt(task: string, writesAllowed: boolean): string {
  return [
    "Objective:",
    task,
    "",
    "Continue the existing MiMoCode session and execute this objective now.",
    "",
    "Rules:",
    ...(writesAllowed
      ? [
          "- Keep changes surgical.",
          "- Do not modify unrelated files.",
          "- Do not commit, push, reset, or delete files.",
          "- Run the narrowest meaningful verification when practical."
        ]
      : [
          "- Do not edit files.",
          "- Continue only the parent session's analysis, planning, or review work."
        ]),
    "- Return the result and any remaining risks."
  ].join("\n");
}

export function resumeContinuationPrompt(input: {
  objective: string;
  checkpoint: JobCheckpoint;
  task?: string;
}): string {
  return [
    "Objective:",
    input.task?.trim() || input.objective,
    "",
    "Continue the existing MiMoCode job from the durable checkpoint. Do not restart discovery.",
    "",
    "Rules:",
    "- Do not perform a broad project scan.",
    "- Do not repeat completed checklist items or completed slices.",
    "- Do not rerun still-valid passed gates listed in the checkpoint.",
    "- Inspect only checkpoint contextFiles and changedFiles as needed.",
    "- Prefer the first remainingChecklist item.",
    "",
    "Checkpoint:",
    "```json",
    JSON.stringify({
      jobId: input.checkpoint.jobId,
      chainId: input.checkpoint.chainId,
      sessionId: input.checkpoint.sessionId,
      contextFiles: input.checkpoint.contextFiles,
      changedFiles: input.checkpoint.changedFiles,
      completedSlices: input.checkpoint.completedSlices,
      completedChecklist: input.checkpoint.completedChecklist,
      remainingChecklist: input.checkpoint.remainingChecklist,
      lastCommand: input.checkpoint.lastCommand,
      acceptance: input.checkpoint.acceptance
    }, null, 2),
    "```"
  ].join("\n");
}
