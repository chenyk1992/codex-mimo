export type ComposeWorkflowName =
  | "dev"
  | "fix"
  | "fix-ci"
  | "plan"
  | "execute-plan"
  | "review"
  | "parallel";

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
}

const workflows: Record<ComposeWorkflowName, ComposeWorkflow> = {
  dev: {
    name: "dev",
    description: "Feature development loop",
    skillChain: ["compose:brainstorm", "compose:plan", "compose:tdd", "compose:verify", "compose:review"],
    defaultVerification: ["npm test"],
    writesAllowed: true,
    requiresTask: true,
    requiresFile: false
  },
  fix: {
    name: "fix",
    description: "Bug fixing loop",
    skillChain: ["compose:debug", "compose:tdd", "compose:verify", "compose:feedback"],
    defaultVerification: ["npm test"],
    writesAllowed: true,
    requiresTask: true,
    requiresFile: false
  },
  "fix-ci": {
    name: "fix-ci",
    description: "CI failure repair loop",
    skillChain: ["compose:debug", "compose:tdd", "compose:verify", "compose:review"],
    defaultVerification: ["npm test"],
    writesAllowed: true,
    requiresTask: false,
    requiresFile: true
  },
  plan: {
    name: "plan",
    description: "Planning-only loop",
    skillChain: ["compose:brainstorm", "compose:plan"],
    defaultVerification: [],
    writesAllowed: false,
    requiresTask: true,
    requiresFile: false
  },
  "execute-plan": {
    name: "execute-plan",
    description: "Execute an approved implementation plan",
    skillChain: ["compose:execute", "compose:tdd", "compose:verify", "compose:review"],
    defaultVerification: ["npm test"],
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
    defaultVerification: ["npm test"],
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
  const lines = [
    `Please use @compose to run the ${workflow.name} workflow.`,
    "",
    `Required Compose skills: ${workflow.skillChain.join(" -> ")}`,
    "",
    "Task:",
    task?.trim() || defaultTaskForWorkflow(workflow.name),
    "",
    "Rules:",
    "- Keep changes minimal and focused.",
    "- Do not commit, push, reset, or delete files.",
    "- Record the plan, actions taken, verification evidence, and remaining risks.",
    "- Prefer named reusable skills over ad-hoc steps.",
    "- Stop and report clearly if the task is blocked."
  ];

  if (file) {
    lines.push("", `Attached/reference file: @${file}`);
  }

  if (since) {
    lines.push("", `Review or compare changes since: ${since}`);
  }

  if (!workflow.writesAllowed) {
    lines.push("", "This workflow is read-only. Do not modify files.");
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
