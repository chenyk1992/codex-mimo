import { COMPOSE_WORKFLOW_NAMES } from "./workflow-names.js";

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

interface BuildComposePromptInput {
  workflow: ComposeWorkflow;
  task?: string;
  file?: string;
  since?: string;
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
    description: "Create or update a Compose skill",
    skillChain: ["compose:new-skill"],
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

export function buildComposePrompt(input: BuildComposePromptInput): string {
  const { workflow, task, file, since } = input;
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
  lines.push("- Record actions taken, verification evidence, and remaining risks.");
  lines.push("- On Windows: use PowerShell-compatible commands. Avoid `2>/dev/null`, `||`, `wc -l`, `grep`. Use `Get-Content | Measure-Object`, `Select-String`, `Test-Path` instead.");

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
    lines.push("- If you cannot complete the full plan, output a partial plan with clear gaps listed.");
  }

  if (workflow.name === "brainstorm") {
    lines.push("");
    lines.push("Use compose:brainstorm to clarify the Objective. Ask concise questions only when needed.");
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
