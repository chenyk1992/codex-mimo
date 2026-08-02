import type { BatchMode } from "../core/jobs.js";

export const COMPOSE_WORKFLOW_NAMES = [
  "brainstorm",
  "dev",
  "fix",
  "fix-ci",
  "plan",
  "execute-plan",
  "review",
  "parallel",
  "worktree",
  "merge",
  "new-skill"
] as const;

export type ComposeWorkflowName = typeof COMPOSE_WORKFLOW_NAMES[number];

export interface ComposeWorkflow {
  name: ComposeWorkflowName;
  description: string;
  skillChain: string[];
  defaultVerification: string[];
  writesAllowed: boolean;
  requiresTask: boolean;
  requiresFile: boolean;
}

export interface BuildComposePromptInput {
  workflow: ComposeWorkflow;
  task?: string;
  file?: string;
  since?: string;
  sourceRef?: string;
  targetRef?: string;
  sourceOid?: string;
  targetOid?: string;
}

export interface ComposeWorkflowInput {
  workflow: ComposeWorkflowName;
  task?: string;
  file?: string;
  batchMode?: BatchMode;
}

export interface DevelopmentAcceptanceInput {
  build?: string[];
  test?: string[];
  diffCheck?: boolean;
  artifactPaths?: string[];
}

export function workflowRequiresDevelopmentAcceptance(
  workflow: ComposeWorkflowName
): boolean {
  return workflow === "dev" ||
    workflow === "fix" ||
    workflow === "fix-ci" ||
    workflow === "execute-plan";
}

export function workflowSupportsBridgeSlicing(
  workflow: ComposeWorkflowName
): boolean {
  return workflow === "dev" ||
    workflow === "fix" ||
    workflow === "execute-plan";
}

const workflows: Record<ComposeWorkflowName, ComposeWorkflow> = {
  brainstorm: {
    name: "brainstorm",
    description: "Clarify fuzzy requirements",
    skillChain: ["compose:brainstorm"],
    defaultVerification: [],
    writesAllowed: false,
    requiresTask: true,
    requiresFile: false
  },
  dev: {
    name: "dev",
    description: "Feature development loop",
    skillChain: ["compose:brainstorm", "compose:plan", "compose:tdd", "compose:verify", "compose:review"],
    defaultVerification: [],
    writesAllowed: true,
    requiresTask: true,
    requiresFile: false
  },
  fix: {
    name: "fix",
    description: "Bug fixing loop",
    skillChain: ["compose:debug", "compose:tdd", "compose:verify", "compose:feedback"],
    defaultVerification: [],
    writesAllowed: true,
    requiresTask: true,
    requiresFile: false
  },
  "fix-ci": {
    name: "fix-ci",
    description: "CI failure repair loop",
    skillChain: ["compose:debug", "compose:tdd", "compose:verify", "compose:review"],
    defaultVerification: [],
    writesAllowed: true,
    requiresTask: false,
    requiresFile: true
  },
  plan: {
    name: "plan",
    description: "Write implementation plan from an already clear requirement",
    skillChain: ["compose:plan"],
    defaultVerification: [],
    writesAllowed: false,
    requiresTask: true,
    requiresFile: false
  },
  "execute-plan": {
    name: "execute-plan",
    description: "Execute an approved implementation plan",
    skillChain: ["compose:execute", "compose:tdd", "compose:verify", "compose:review"],
    defaultVerification: [],
    writesAllowed: true,
    requiresTask: false,
    requiresFile: true
  },
  review: {
    name: "review",
    description: "Review current diff",
    skillChain: ["compose:review", "compose:feedback"],
    defaultVerification: [],
    writesAllowed: false,
    requiresTask: false,
    requiresFile: false
  },
  parallel: {
    name: "parallel",
    description: "Parallel exploration loop",
    skillChain: ["compose:parallel", "compose:subagent", "compose:verify"],
    defaultVerification: [],
    writesAllowed: true,
    requiresTask: true,
    requiresFile: false
  },
  worktree: {
    name: "worktree",
    description: "Isolate work in a git worktree",
    skillChain: ["compose:worktree"],
    defaultVerification: [],
    writesAllowed: true,
    requiresTask: true,
    requiresFile: false
  },
  merge: {
    name: "merge",
    description: "Finish or merge a development branch",
    skillChain: ["compose:merge"],
    defaultVerification: [],
    writesAllowed: true,
    requiresTask: true,
    requiresFile: false
  },
  "new-skill": {
    name: "new-skill",
    description: "Draft and write a new Compose skill into the project's .claude/skills or .mimocode/skills directory",
    skillChain: ["compose:execute", "compose:verify"],
    defaultVerification: [],
    writesAllowed: true,
    requiresTask: true,
    requiresFile: false
  }
};

export function getComposeWorkflow(name: string): ComposeWorkflow {
  if (!(name in workflows)) {
    throw new Error(`Unknown Compose workflow: ${name}`);
  }
  return workflows[name as ComposeWorkflowName];
}

export function listComposeWorkflows(): ComposeWorkflow[] {
  return Object.values(workflows);
}

export function validateComposeWorkflowInput(input: ComposeWorkflowInput): string[] {
  const workflow = getComposeWorkflow(input.workflow);
  const issues: string[] = [];
  if (workflow.requiresTask && !input.task?.trim()) {
    issues.push(`Workflow ${input.workflow} requires a task.`);
  }
  if (workflow.requiresFile && !input.file?.trim()) {
    issues.push(`Workflow ${input.workflow} requires a file.`);
  }
  return issues;
}

export function normalizeComposeBatchMode<
  Request extends ComposeWorkflowInput & { batchMode?: BatchMode }
>(request: Request): Request {
  const workflow = getComposeWorkflow(request.workflow);
  if (workflow.writesAllowed && workflowSupportsBridgeSlicing(workflow.name)) {
    return { ...request, batchMode: request.batchMode ?? "auto" };
  }
  if (request.batchMode === undefined) {
    return request;
  }
  const { batchMode: _ignored, ...rest } = request;
  return rest as Request;
}

export function buildComposePrompt(input: BuildComposePromptInput): string {
  const { workflow, task, file, since, sourceRef, targetRef, sourceOid, targetOid } = input;
  const lines: string[] = [];
  const objective = task?.trim() || defaultTaskForWorkflow(workflow.name);

  lines.push(`Objective: ${objective}`);
  lines.push("");
  lines.push(`Workflow: ${workflow.name} - ${workflow.description}`);
  lines.push("");
  lines.push(`Use these Compose skills in order: ${workflow.skillChain.join(" -> ")}`);
  lines.push("");
  lines.push("Instructions:");
  lines.push("- Treat the Objective above as the task input for this workflow.");
  lines.push("- Do not ask what to plan or implement unless the Objective is genuinely ambiguous.");
  lines.push("- Keep changes minimal and focused.");
  lines.push("- Do not commit, push, reset, or delete files.");
  if (workflow.name === "worktree") {
    lines.push("- The current working directory is the only bridge-owned worktree. Do not create, remove, switch, checkout, branch, reset, or otherwise manage Git worktrees or branches.");
    lines.push("- Do not access the control workspace or any external directory; work only inside the current working directory.");
  }
  if (workflow.name === "merge") {
    lines.push("- The current working directory is a clean, detached, bridge-owned merge worktree. Do not access the control workspace or any external directory.");
    lines.push("- The bridge has already started the merge. Resolve content conflicts only; stage the resolved files, but never commit, checkout, reset, switch branches, alter refs, or create/remove worktrees.");
    lines.push(`- Pinned source: ${sourceRef ?? "(bridge supplied)"}${sourceOid ? ` at ${sourceOid}` : ""}.`);
    lines.push(`- Pinned target: ${targetRef ?? "(bridge supplied)"}${targetOid ? ` at ${targetOid}` : ""}.`);
  }
  lines.push("- Record actions taken, verification evidence, and remaining risks.");
  lines.push("- On Windows: use PowerShell-compatible commands. Avoid `2>/dev/null`, `||`, `wc -l`, `grep`. Use `Get-Content -Encoding UTF8 | Measure-Object`, `Select-String`, and `Test-Path` instead.");
  lines.push("- On Windows Python commands: prefer UTF-8 mode (`PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`; in PowerShell set `$env:PYTHONUTF8='1'; $env:PYTHONIOENCODING='utf-8'`) so `Path.read_text()` does not default to cp936.");

  if (workflow.name === "plan") {
    lines.push("");
    lines.push(
      "The Objective above is the requirement/spec for compose:plan. Produce a plan from it; do not ask for a separate spec unless it is genuinely missing critical information."
    );
    lines.push("");
    lines.push("CONVERGENCE RULES:");
    lines.push("- Your final deliverable MUST be a plan document, not an analysis report.");
    lines.push("- Limit exploration to the minimum needed. Do not read every file in the codebase.");
    lines.push("- If the Objective covers multiple independent subsystems, produce a plan index with sub-plan outlines — do not attempt one exhaustive plan.");
    lines.push("- Stop exploring and start writing the plan as soon as you have enough context to identify files and interfaces.");
    lines.push("- Intermediate analysis (code reviews, file surveys) must feed into the plan, not replace it.");
    lines.push("- Structure the final plan as: Conclusions, Evidence, Assumptions and Unknowns, Ordered Implementation Steps, Executable Acceptance.");
    lines.push("- Support conclusions with repository files, interfaces, tests, or command output inspected in this run.");
    lines.push("- Do not claim behavior is existing, safe, or idempotent without repository evidence; label unsupported inferences as assumptions.");
    lines.push("- Acceptance entries must be directly executable commands, not prose criteria.");
    lines.push("- If you cannot complete the full plan, output a partial plan with clear gaps listed.");
    lines.push("- Return the plan in your final response only. Do not save plan files, project docs, reports, or notes to disk.");
    lines.push("- Do not invoke compose:execute, compose:subagent, compose:tdd, compose:verify, compose:report, or any implementation handoff.");
    lines.push("- Do not run implementation steps or commit, even if the compose:plan skill suggests frequent commits or execution handoff.");
  }

  if (workflow.name === "brainstorm") {
    lines.push("");
    lines.push("Use compose:brainstorm to clarify the Objective. Ask concise questions only when needed.");
    lines.push("- Keep the final synthesis concise: Conclusions, Evidence, Assumptions and Unknowns, Options and Tradeoffs, Recommended Next Steps, Executable Acceptance.");
    lines.push("- Separate observed repository evidence from assumptions and open questions.");
    lines.push("- Do not call a proposal idempotent or already supported without repository evidence; otherwise label it as an assumption.");
  }

  if (file) {
    lines.push("");
    lines.push(`Attached/reference file: @${file}`);
  }

  if (since) {
    lines.push("");
    lines.push(`Review or compare changes since: ${since}`);
  }

  if (!workflow.writesAllowed) {
    lines.push("");
    lines.push("This workflow is read-only. Do not modify files.");
  }

  return lines.join("\n");
}

function defaultTaskForWorkflow(name: ComposeWorkflowName): string {
  switch (name) {
    case "fix-ci":
      return "Fix the failures described in the attached CI log.";
    case "execute-plan":
      return "Execute the approved implementation plan in the attached file.";
    case "review":
      return "Review the current diff for correctness, regressions, security issues, and missing tests.";
    default:
      return `Run the ${name} workflow.`;
  }
}
